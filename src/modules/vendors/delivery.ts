import { and, desc, eq, lt } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { type Tx, withTenant } from "../../db/client";
import { companies, gangSheets, vendorConnections, vendorSheetDeliveries } from "../../db/schema";
import { type SheetDelivery, vendorAdapter } from "../../integrations/vendors";
import { audit } from "../../lib/audit";
import { badRequest, ORPCError } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { lockSheet, sheetDownloadUrls } from "../production/service";
import { raiseAlert } from "../today/service";

const log = logger("vendors.delivery");

/*
 * Sheet delivery to the vendor (B-102, T-22-5). The sending transaction writes a
 * `vendor_sheet_deliveries` row (`pending`) and an outbox event; a job delivers it after the
 * commit, so a rolled-back send never emails and a slow SMTP server never holds the sheet lock.
 * Exactly-once in effect, per row:
 *   Tx 1  lock the rows, pick the newest `pending` one, build the signed links (no tx), then
 *         lock again and `pending` -> `sending` (claim time, attempt count) right before the send.
 *   send  no transaction open, raced against SEND_TIMEOUT_MS.
 *   Tx 2  `sending` -> `sent` with the message id.
 * A retry that finds `sending` older than STALE_CLAIM_MS (the attempt died between claim and
 * Tx 2: worker killed, timeout) marks it `unknown` and does not send again: SMTP has no
 * read-back, and a second copy is worse than a missing one the office can resend. An SMTP error
 * is a refusal (nothing was accepted), so it goes back to `pending` and the job retries. A row
 * that ends `unknown` or `failed` raises one office alert (per row) to resend by hand.
 */

/** A resend is refused inside this window after the last send or resend of the same sheet. */
export const RESEND_WINDOW_SEC = 10 * 60;
/** The send is abandoned (row -> `unknown`) after this long; shorter than the `ship` lock (60 s). */
export const SEND_TIMEOUT_MS = 45_000;
/** A `sending` claim older than this can't still be in flight (timeout + Tx 2 margin). */
export const STALE_CLAIM_MS = SEND_TIMEOUT_MS + 5_000;
/** Emailed links are bearer URLs to the shop's artwork: 24 hours. */
const EMAIL_LINK_TTL = 24 * 3600;
/** States a sheet can be in once it went to a vendor (resend is allowed in all of them). */
const SENT_STATES = new Set(["sent", "acknowledged", "printed", "shipped", "received"]);

/** Internal outbox event for a resend (the first send rides the contract's `sheet.sent`). */
export const RESEND_EVENT = "vendor.sheet_resend_requested";

type DeliveryRow = typeof vendorSheetDeliveries.$inferSelect;

async function nextSeq(tx: Tx, sheetId: string) {
  const [last] = await tx
    .select()
    .from(vendorSheetDeliveries)
    .where(eq(vendorSheetDeliveries.gangSheetId, sheetId))
    .orderBy(desc(vendorSheetDeliveries.seq))
    .limit(1);
  return { last: last ?? null, seq: (last?.seq ?? 0) + 1 };
}

/** Called by `sendSheetToVendor` inside its transaction (the sheet row is already locked). */
export async function queueSheetDelivery(
  tx: Tx,
  ctx: TenantContext,
  input: { sheetId: string; vendorConnectionId: string; delivery: "portal" | "email" },
): Promise<DeliveryRow> {
  const { seq } = await nextSeq(tx, input.sheetId);
  const [row] = await tx
    .insert(vendorSheetDeliveries)
    .values({
      companyId: ctx.companyId,
      gangSheetId: input.sheetId,
      vendorConnectionId: input.vendorConnectionId,
      delivery: input.delivery,
      seq,
      requestedBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error("delivery insert returned no row");
  return row;
}

function resendTooSoon(retryAfterSec: number, lastSentAt: Date) {
  return new ORPCError("RESEND_TOO_SOON", {
    status: 429,
    message: `The email went out less than 10 minutes ago. Try again in ${Math.ceil(retryAfterSec / 60)} min.`,
    data: { retryAfterSec, lastSentAt: lastSentAt.toISOString() },
  });
}

/**
 * `vendors.sheets.resendEmail`: send the "sheet ready" email again (a lost or bounced message).
 * Once per sheet per RESEND_WINDOW_SEC, counted from the last send or resend request; the sheet
 * row lock serializes two clicks, so the second one is refused, never sent twice.
 */
export async function resendSheetEmail(
  tx: Tx,
  ctx: TenantContext,
  input: { sheetId: string },
  now: Date = new Date(),
): Promise<{ sheetId: string; sentAt: string }> {
  const sheet = await lockSheet(tx, input.sheetId);
  if (!SENT_STATES.has(sheet.status) || !sheet.vendorConnectionId)
    throw new ORPCError("SHEET_NOT_SENT", {
      status: 409,
      message: "This sheet has not been sent to a vendor yet",
    });
  const [conn] = await tx
    .select()
    .from(vendorConnections)
    .where(eq(vendorConnections.id, sheet.vendorConnectionId))
    .limit(1);
  if (!conn)
    throw new ORPCError("SHEET_NOT_SENT", {
      status: 409,
      message: "This sheet's vendor was removed; send the sheet again",
    });
  if (conn.status === "paused") throw badRequest(`Vendor ${conn.name} is paused`);
  const { last, seq } = await nextSeq(tx, sheet.id);
  // How it went last time; sheets sent before deliveries were recorded follow the connection.
  const portal = last
    ? last.delivery === "portal"
    : conn.delivery === "portal" && conn.status === "active" && !!conn.vendorCompanyId;
  if (portal)
    throw new ORPCError("VENDOR_USES_PORTAL", {
      status: 409,
      message: "This vendor gets sheets in the portal, not by email",
    });
  // A delivery that failed for good sent nothing, so it doesn't start the window.
  const lastAt = last
    ? last.status === "failed"
      ? null
      : (last.sentAt ?? last.createdAt)
    : sheet.sentAt;
  if (lastAt) {
    const age = (now.getTime() - lastAt.getTime()) / 1000;
    if (age < RESEND_WINDOW_SEC) throw resendTooSoon(Math.ceil(RESEND_WINDOW_SEC - age), lastAt);
  }
  const [row] = await tx
    .insert(vendorSheetDeliveries)
    .values({
      companyId: ctx.companyId,
      gangSheetId: sheet.id,
      vendorConnectionId: conn.id,
      delivery: "email",
      seq,
      requestedBy: ctx.userId,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("delivery insert returned no row");
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "sheet.email_resent",
    entityType: "gang_sheet",
    entityId: sheet.id,
    summary: `Sheet ${sheet.name} emailed again to ${conn.name}`,
    data: { deliveryId: row.id, seq },
  });
  await emit(tx, ctx.companyId, RESEND_EVENT, { sheetId: sheet.id, deliveryId: row.id });
  return { sheetId: sheet.id, sentAt: row.createdAt.toISOString() };
}

export type DeliverOutcome =
  | { status: "sent"; deliveryId: string; messageId: string | null }
  | { status: "skipped"; reason: "nothing_pending" | "in_flight" }
  | { status: "unknown"; deliveryId: string };

const noneLeft: DeliverOutcome = { status: "skipped", reason: "nothing_pending" };

type Picked = {
  row: DeliveryRow;
  sheet: typeof gangSheets.$inferSelect;
  conn: typeof vendorConnections.$inferSelect;
  shopName: string;
};

/** A short, PII-free reason: nodemailer's code or SMTP status, never the server's text. */
function errorCode(err: unknown): { code: string; permanent: boolean } {
  const e = err as { code?: unknown; responseCode?: unknown };
  const status = typeof e?.responseCode === "number" ? e.responseCode : null;
  const code = typeof e?.code === "string" ? e.code : "SEND_FAILED";
  return { code: status ? `${code} ${status}` : code, permanent: status !== null && status >= 500 };
}

/*
 * The office must hear about an email that didn't (or may not have) gone out: the sheet already
 * says "sent". One open alert per delivery row (dedupe key), raised in the transaction that
 * ends the row. No dedicated alert kind exists yet, and `sheet_stuck` is resolved by the
 * 5-minute sweep whenever the sheet isn't 24 h late, so this uses the non-swept
 * `tracking_push_failed`, as shipping's stuck-intent alerts do. Spanish rides in `data` until
 * alerts carry both languages.
 */
async function alertLostDelivery(
  tx: Tx,
  companyId: string,
  d: { id: string; sheetId: string; outcome: "unknown" | "failed"; reason: string },
) {
  const [info] = await tx
    .select({ sheet: gangSheets.name, vendor: vendorConnections.name })
    .from(vendorSheetDeliveries)
    .innerJoin(gangSheets, eq(gangSheets.id, vendorSheetDeliveries.gangSheetId))
    .innerJoin(
      vendorConnections,
      eq(vendorConnections.id, vendorSheetDeliveries.vendorConnectionId),
    )
    .where(eq(vendorSheetDeliveries.id, d.id))
    .limit(1);
  const sheet = info?.sheet ?? "";
  const vendor = info?.vendor ?? "the vendor";
  const copy =
    d.outcome === "unknown"
      ? {
          title: `Sheet ${sheet}: the email to ${vendor} may not have gone out`,
          message: "We couldn't confirm the email was sent. Open the sheet and resend the email.",
          titleEs: `Hoja ${sheet}: puede que el correo a ${vendor} no se haya enviado`,
          messageEs: "No pudimos confirmar el envío. Abre la hoja y reenvía el correo.",
        }
      : {
          title: `Sheet ${sheet}: the email to ${vendor} didn't go out`,
          message: "Check the vendor's email address, then open the sheet and resend the email.",
          titleEs: `Hoja ${sheet}: el correo a ${vendor} no se envió`,
          messageEs: "Revisa el correo del proveedor, luego abre la hoja y reenvía el correo.",
        };
  await raiseAlert(tx, companyId, {
    kind: "tracking_push_failed",
    severity: "warning",
    title: copy.title,
    message: copy.message,
    entityType: "gang_sheet",
    entityId: d.sheetId,
    dedupeKey: `vendor-sheet-delivery-${d.id}`,
    data: {
      intent: "vendor_sheet_email",
      deliveryId: d.id,
      outcome: d.outcome,
      reason: d.reason,
      titleEs: copy.titleEs,
      messageEs: copy.messageEs,
    },
    messageCode: d.outcome === "unknown" ? "vendor_email_unconfirmed" : "vendor_email_failed",
    // The English fallback message may still say "the vendor" (prose), but a translated line
    // built from params must never show that English phrase, so the key is left out entirely
    // when the vendor's name is unknown (review round 2, finding 3).
    params: { sheetName: sheet, ...(info?.vendor ? { vendorName: info.vendor } : {}) },
  });
}

/** `sending` -> `unknown`/`failed`/`pending` (only if still `sending`), alerting on a lost one. */
async function endAttempt(
  companyId: string,
  sheetId: string,
  deliveryId: string,
  to: "unknown" | "failed" | "pending",
  reason: string,
  from: "sending" | "pending" = "sending",
) {
  await withTenant(companyId, async (tx) => {
    const [ended] = await tx
      .update(vendorSheetDeliveries)
      .set({ status: to, lastError: reason, ...(to === "unknown" ? {} : { claimedAt: null }) })
      .where(and(eq(vendorSheetDeliveries.id, deliveryId), eq(vendorSheetDeliveries.status, from)))
      .returning({ id: vendorSheetDeliveries.id });
    if (ended && to !== "pending")
      await alertLostDelivery(tx, companyId, { id: deliveryId, sheetId, outcome: to, reason });
  });
}

/**
 * Deliver the newest pending delivery of a sheet (the job handler's body). Older pending rows
 * of the same sheet are superseded, so one run sends at most one message. `attempt`/`attempts`
 * come from BullMQ; the last failed attempt leaves the row `failed`. The row is claimed only
 * after the links are built, right before the SMTP call, so a worker that dies earlier leaves it
 * `pending` and the retry sends the one email.
 */
export async function deliverPendingSheet(
  companyId: string,
  sheetId: string,
  run: { lastAttempt: boolean; now?: () => Date } = { lastAttempt: true },
): Promise<DeliverOutcome> {
  const now = run.now ?? (() => new Date());
  const picked = await withTenant(companyId, async (tx): Promise<Picked | DeliverOutcome> => {
    const rows = await tx
      .select()
      .from(vendorSheetDeliveries)
      .where(eq(vendorSheetDeliveries.gangSheetId, sheetId))
      .orderBy(desc(vendorSheetDeliveries.seq))
      .for("update");
    const at = now();
    const sending = rows.find((r) => r.status === "sending");
    if (sending) {
      if (at.getTime() - (sending.claimedAt?.getTime() ?? 0) < STALE_CLAIM_MS)
        return { status: "skipped", reason: "in_flight" };
      const reason = "attempt ended without a result";
      await tx
        .update(vendorSheetDeliveries)
        .set({ status: "unknown", lastError: reason })
        .where(eq(vendorSheetDeliveries.id, sending.id));
      await alertLostDelivery(tx, companyId, {
        id: sending.id,
        sheetId,
        outcome: "unknown",
        reason,
      });
      log.warn("sheet delivery outcome unknown, not resending", {
        companyId,
        sheetId,
        deliveryId: sending.id,
      });
    }
    const pending = rows.filter((r) => r.status === "pending");
    const [row, ...older] = pending;
    if (older.length)
      await tx
        .update(vendorSheetDeliveries)
        .set({ status: "failed", lastError: "superseded by a newer send" })
        .where(
          and(
            eq(vendorSheetDeliveries.gangSheetId, sheetId),
            eq(vendorSheetDeliveries.status, "pending"),
            lt(vendorSheetDeliveries.seq, row?.seq ?? 0),
          ),
        );
    if (!row) return sending ? { status: "unknown", deliveryId: sending.id } : noneLeft;
    const [sheet] = await tx.select().from(gangSheets).where(eq(gangSheets.id, sheetId)).limit(1);
    const [conn] = await tx
      .select()
      .from(vendorConnections)
      .where(eq(vendorConnections.id, row.vendorConnectionId))
      .limit(1);
    if (!sheet || !conn || sheet.status === "cancelled" || conn.status === "paused") {
      await tx
        .update(vendorSheetDeliveries)
        .set({ status: "failed", lastError: !sheet || !conn ? "gone" : `sheet ${sheet.status}` })
        .where(eq(vendorSheetDeliveries.id, row.id));
      return noneLeft;
    }
    const [shop] = await tx
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId));
    return { row, sheet, conn, shopName: shop?.name ?? "InvAI shop" };
  });
  if ("status" in picked) return picked;

  const { sheet, conn, shopName } = picked;
  const portal = picked.row.delivery === "portal";
  let links: SheetDelivery["links"];
  try {
    links = portal
      ? { png: null, pdf: null, preview: null, expiresAt: now().toISOString() }
      : await sheetDownloadUrls(sheet, EMAIL_LINK_TTL);
  } catch (err) {
    // Nothing was claimed or sent: the row stays `pending` for the retry, `failed` on the last.
    if (run.lastAttempt)
      await endAttempt(companyId, sheetId, picked.row.id, "failed", "LINKS_FAILED", "pending");
    throw err;
  }

  // Claim right before the send: still the newest `pending` row, and nobody else is sending.
  const row = await withTenant(companyId, async (tx) => {
    const rows = await tx
      .select()
      .from(vendorSheetDeliveries)
      .where(eq(vendorSheetDeliveries.gangSheetId, sheetId))
      .orderBy(desc(vendorSheetDeliveries.seq))
      .for("update");
    const mine = rows.find((r) => r.id === picked.row.id);
    if (mine?.status !== "pending" || rows.some((r) => r.status === "sending")) return null;
    const [claim] = await tx
      .update(vendorSheetDeliveries)
      .set({ status: "sending", claimedAt: now(), attempts: mine.attempts + 1 })
      .where(eq(vendorSheetDeliveries.id, mine.id))
      .returning();
    return claim ?? null;
  });
  if (!row) return { status: "skipped", reason: "in_flight" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: { reference: string | null } | "timeout";
  try {
    result = await Promise.race([
      vendorAdapter(row.delivery).deliver({
        companyId,
        sheetId: sheet.id,
        sheetName: sheet.name,
        shopName,
        vendor: { name: conn.name, email: conn.email, vendorCompanyId: conn.vendorCompanyId },
        lengthIn: sheet.lengthIn,
        widthIn: sheet.widthIn,
        transferCount: sheet.transferCount,
        format: sheet.pdfKey ? "pdf" : "png",
        note: sheet.vendorNotes ?? null,
        links,
      }),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), SEND_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    const { code, permanent } = errorCode(err);
    const failed = permanent || run.lastAttempt;
    await endAttempt(companyId, sheetId, row.id, failed ? "failed" : "pending", code);
    log.warn("sheet delivery failed", { companyId, sheetId, deliveryId: row.id, code, failed });
    throw Object.assign(new Error(`sheet delivery failed: ${code}`), { permanent });
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (result === "timeout") {
    await endAttempt(companyId, sheetId, row.id, "unknown", "timed out");
    log.warn("sheet delivery timed out, not resending", { companyId, sheetId, deliveryId: row.id });
    return { status: "unknown", deliveryId: row.id };
  }
  const messageId = result.reference;
  await withTenant(companyId, async (tx) => {
    await tx
      .update(vendorSheetDeliveries)
      .set({ status: "sent", sentAt: now(), messageId, lastError: null })
      .where(eq(vendorSheetDeliveries.id, row.id));
    await audit(tx, {
      companyId,
      actor: { kind: "system" },
      action: "sheet.delivered",
      entityType: "gang_sheet",
      entityId: sheet.id,
      summary: `Sheet ${sheet.name} ${portal ? "shared in the portal of" : "emailed to"} ${conn.name}`,
      data: { deliveryId: row.id, seq: row.seq, delivery: row.delivery },
    });
  });
  log.info("sheet delivered", { companyId, sheetId, deliveryId: row.id, seq: row.seq });
  return { status: "sent", deliveryId: row.id, messageId };
}
