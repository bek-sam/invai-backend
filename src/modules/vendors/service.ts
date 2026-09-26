import {
  DEFAULT_SHEET_SPEC,
  type GangSheet,
  SHEET_STATES,
  type SheetState,
  sheetSpecPdfCapError,
  type VendorConnection,
  type VendorInboxSheet,
  type VendorInviteInput as VendorInviteInputSchema,
  type VendorShop,
} from "@invai/contracts";
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx, withSystem, withTenant, withVendor } from "../../db/client";
import type { SheetSpec } from "../../db/schema";
import {
  companies,
  gangSheets,
  invitations,
  members,
  users,
  vendorAccess,
  vendorConnections,
} from "../../db/schema";
import { env } from "../../env";
import { vendorAdapter } from "../../integrations/vendors";
import { type Actor, audit } from "../../lib/audit";
import { randomToken } from "../../lib/crypto";
import { badRequest, conflict, notFound, ORPCError, upstream } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { publish } from "../../lib/realtime";
import {
  getSheet,
  lockSheet,
  sheetDownloadUrls,
  sheetPlacements,
  toGangSheet,
  transitionSheet,
} from "../production/service";
import {
  deliverInviteMail,
  inviteExpiry,
  inviteLink,
  inviteSenders,
  sendInviteEmail,
  VENDOR_INVITE_DAYS,
} from "../tenancy/invites";

const log = logger("vendors");

/*
 * DTF vendors. Shop side: connections (invite, spec, default) and sheet delivery (portal grant or
 * email with signed links). Vendor side (`withVendor`): one inbox across every shop that shared
 * sheets, and the status updates (acknowledged / printed / shipped / rejected) that flow back to
 * the shop. Sheet rows belong to production; status changes go through its `transitionSheet`.
 */

type ConnectionRow = typeof vendorConnections.$inferSelect;
type VendorInviteInput = z.infer<typeof VendorInviteInputSchema>;

const OPEN_SHEET_STATES: SheetState[] = ["sent", "acknowledged", "printed", "shipped"];

/* ------------------------------- connections ------------------------------- */

export function toVendorConnection(row: ConnectionRow, sheetsOpen: number): VendorConnection {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    vendorOrgId: row.vendorCompanyId,
    status: row.status,
    delivery: row.delivery,
    spec: { ...DEFAULT_SHEET_SPEC, ...row.spec },
    isDefault: row.isDefault,
    turnaroundDays: row.turnaroundDays,
    sheetsOpen,
    invitedAt: row.invitedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function openSheetCounts(tx: Tx, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await tx
    .select({ id: gangSheets.vendorConnectionId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(gangSheets)
    .where(
      and(
        inArray(gangSheets.vendorConnectionId, ids),
        inArray(gangSheets.status, OPEN_SHEET_STATES),
      ),
    )
    .groupBy(gangSheets.vendorConnectionId);
  return new Map(rows.map((r) => [r.id as string, r.n]));
}

export async function listConnections(tx: Tx, _ctx: TenantContext) {
  const rows = await tx
    .select()
    .from(vendorConnections)
    .orderBy(desc(vendorConnections.isDefault), asc(vendorConnections.name));
  const counts = await openSheetCounts(
    tx,
    rows.map((r) => r.id),
  );
  return { items: rows.map((r) => toVendorConnection(r, counts.get(r.id) ?? 0)) };
}

async function connectionRow(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(vendorConnections)
    .where(eq(vendorConnections.id, id))
    .limit(1);
  if (!row) throw notFound("vendor connection", id);
  return row;
}

export async function getConnection(tx: Tx, _ctx: TenantContext, id: string) {
  const row = await connectionRow(tx, id);
  return toVendorConnection(row, (await openSheetCounts(tx, [id])).get(id) ?? 0);
}

async function clearDefault(tx: Tx, exceptId: string) {
  await tx
    .update(vendorConnections)
    .set({ isDefault: false })
    .where(and(eq(vendorConnections.isDefault, true), sql`${vendorConnections.id} <> ${exceptId}`));
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "vendor";

/**
 * Invite a DTF vendor by email. An email that already belongs to a vendor org links to it, but
 * the connection stays `invited` until that org accepts in its portal. Otherwise a vendor org is
 * created with a Better Auth organization invitation for that email. Until then sheets go by email.
 *
 * No transaction is open while the email goes out (idempotent-side-effect):
 *   1. the vendor org and its invitation are committed (short system transaction);
 *   2. the email is sent;
 *   3. on success the shop's connection, audit row and `vendor.invited` event are committed; on
 *      failure the new vendor org (and its invitation) is deleted and the call fails with
 *      UPSTREAM_FAILED, so the shop never sees "invited" for a vendor who got nothing.
 */
export async function inviteVendor(ctx: TenantContext, input: VendorInviteInput) {
  // B-80: reject an over-length PDF spec before any org/invite side effect runs.
  const inviteSpecError = sheetSpecPdfCapError({ ...DEFAULT_SHEET_SPEC, ...input.spec });
  if (inviteSpecError) throw badRequest(inviteSpecError);

  const email = input.email.trim().toLowerCase();
  const assertNotConnected = async (tx: Tx) => {
    const [dup] = await tx
      .select({ id: vendorConnections.id })
      .from(vendorConnections)
      .where(sql`lower(${vendorConnections.email}) = ${email}`)
      .limit(1);
    if (dup) throw conflict("That vendor is already connected");
  };
  await withTenant(ctx.companyId, assertNotConnected);

  const existingOrg = await withSystem(async (stx) => {
    const [row] = await stx
      .select({ orgId: companies.id })
      .from(users)
      .innerJoin(members, eq(members.userId, users.id))
      .innerJoin(companies, eq(companies.id, members.organizationId))
      .where(
        and(eq(users.email, email), eq(companies.type, "vendor"), eq(members.status, "active")),
      )
      .limit(1);
    return row?.orgId ?? null;
  });

  let vendorCompanyId = existingOrg;
  let invitation: { id: string; expiresAt: Date | null } | null = null;
  if (!vendorCompanyId) {
    const inviterId = ctx.userId;
    if (!inviterId) throw badRequest("Sign in as a person to invite a vendor");
    // The vendor org and its Better Auth invitation. The vendor accepts at /accept-invite/<id>.
    const created = await withSystem(async (stx) => {
      const [org] = await stx
        .insert(companies)
        .values({
          name: input.name,
          slug: `${slugify(input.name)}-${randomToken(4)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "")}`,
          type: "vendor",
          plan: null,
        })
        .returning({ id: companies.id });
      if (!org) throw new Error("vendor org insert failed");
      const [inv] = await stx
        .insert(invitations)
        .values({
          organizationId: org.id,
          email,
          role: "vendor",
          status: "pending",
          inviterId,
          expiresAt: inviteExpiry(VENDOR_INVITE_DAYS),
        })
        .returning({ id: invitations.id, expiresAt: invitations.expiresAt });
      if (!inv) throw new Error("vendor invitation insert failed");
      return { orgId: org.id, invitation: inv };
    });
    vendorCompanyId = created.orgId;
    invitation = created.invitation;
  }
  const removeNewOrg = async () => {
    const orgId = vendorCompanyId;
    if (invitation && orgId)
      await withSystem((stx) => stx.delete(companies).where(eq(companies.id, orgId)));
  };

  const senders = await inviteSenders(ctx.companyId, ctx.userId);
  try {
    if (invitation) {
      await sendInviteEmail(email, {
        ...senders,
        kind: "vendor",
        role: "vendor",
        link: inviteLink(invitation.id),
        expiresAt: invitation.expiresAt ?? inviteExpiry(VENDOR_INVITE_DAYS),
      });
    } else {
      // Already has a vendor account: accepting is opening the shop list in their portal.
      const link = `${env.WEB_ORIGIN}/vendor/shops`;
      await deliverInviteMail(
        {
          to: email,
          subject: `${senders.companyName} invited you to InvAI`,
          text: `${senders.companyName} wants to send you DTF gang sheets through InvAI.\n\nOpen your vendor portal to accept: ${link}\n\nUntil then, sheets arrive by email with download links.`,
        },
        ctx,
      );
    }
  } catch (err) {
    await removeNewOrg();
    throw err;
  }

  // Always `invited`: even a known vendor org must accept (opening the shop list in its portal
  // activates the connection, see activatePending). Until then sheets go by email.
  try {
    return await withTenant(ctx.companyId, async (tx) => {
      await assertNotConnected(tx);
      const [row] = await tx
        .insert(vendorConnections)
        .values({
          companyId: ctx.companyId,
          vendorCompanyId,
          name: input.name,
          email,
          status: "invited",
          delivery: "email",
          spec: { ...DEFAULT_SHEET_SPEC, ...input.spec } as SheetSpec,
          isDefault: input.isDefault,
          turnaroundDays: input.turnaroundDays,
          acceptedAt: null,
        })
        .returning();
      if (!row) throw new Error("vendor connection insert failed");
      if (input.isDefault) await clearDefault(tx, row.id);
      await audit(tx, {
        companyId: ctx.companyId,
        actor: ctx.actor,
        action: "vendor.invited",
        entityType: "vendor_connection",
        entityId: row.id,
        summary: `Vendor ${input.name} <${email}> invited`,
      });
      await emit(tx, ctx.companyId, "vendor.invited", { vendorConnectionId: row.id, email });
      return toVendorConnection(row, 0);
    });
  } catch (err) {
    // Someone connected the same vendor while the email was going out: don't leave an orphan org.
    await removeNewOrg();
    throw err;
  }
}

export async function updateConnection(
  tx: Tx,
  ctx: TenantContext,
  input: {
    id: string;
    name?: string | undefined;
    spec?: Partial<SheetSpec> | undefined;
    turnaroundDays?: number | undefined;
    status?: "active" | "paused" | undefined;
  },
) {
  const row = await connectionRow(tx, input.id);
  if (input.status === "active" && row.status === "invited" && !row.acceptedAt)
    throw badRequest("The vendor hasn't accepted the invite yet");
  const spec = { ...DEFAULT_SHEET_SPEC, ...row.spec, ...(input.spec ?? {}) };
  if (spec.maxLengthIn <= 2 * spec.marginIn || spec.widthIn <= 2 * spec.marginIn)
    throw badRequest("Sheet size is smaller than its margins");
  const updateSpecError = sheetSpecPdfCapError(spec); // B-80
  if (updateSpecError) throw badRequest(updateSpecError);
  await tx
    .update(vendorConnections)
    .set({
      name: input.name ?? row.name,
      spec,
      turnaroundDays: input.turnaroundDays ?? row.turnaroundDays,
      status: input.status ?? row.status,
    })
    .where(eq(vendorConnections.id, input.id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "vendor_connection",
    entityId: input.id,
    summary: `Vendor ${input.name ?? row.name} updated`,
  });
  return getConnection(tx, ctx, input.id);
}

export async function setDefaultConnection(tx: Tx, ctx: TenantContext, id: string) {
  await connectionRow(tx, id);
  await clearDefault(tx, id);
  await tx.update(vendorConnections).set({ isDefault: true }).where(eq(vendorConnections.id, id));
  return getConnection(tx, ctx, id);
}

export async function removeConnection(tx: Tx, ctx: TenantContext, id: string) {
  const row = await connectionRow(tx, id);
  const open = (await openSheetCounts(tx, [id])).get(id) ?? 0;
  if (open > 0)
    throw new ORPCError("VENDOR_HAS_OPEN_SHEETS", {
      status: 409,
      message: "Vendor still has open sheets",
      data: { sheetsOpen: open },
    });
  if (row.vendorCompanyId)
    await tx
      .update(vendorAccess)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(vendorAccess.vendorCompanyId, row.vendorCompanyId), isNull(vendorAccess.revokedAt)),
      );
  await tx.delete(vendorConnections).where(eq(vendorConnections.id, id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "vendor_connection",
    entityId: id,
    summary: `Vendor ${row.name} removed`,
  });
  return { ok: true as const };
}

/* --------------------------------- delivery -------------------------------- */

/**
 * 24 hours: emailed links are bearer URLs to the shop's artwork, and with IAM-role credentials a
 * presigned URL cannot outlive the session anyway. Portal vendors re-sign on every download.
 */
const EMAIL_LINK_TTL = 24 * 3600;

/**
 * Send a ready sheet to a vendor: portal = `vendor_access` grant + notification, email = SMTP with
 * signed download links. Sheet ready -> sent; the delivery runs inside the transaction, so a
 * failed send leaves the sheet ready.
 */
export async function sendSheetToVendor(
  tx: Tx,
  ctx: TenantContext,
  input: { id: string; vendorConnectionId?: string | undefined; note?: string | undefined },
): Promise<GangSheet> {
  const sheet = await lockSheet(tx, input.id);
  const connId = input.vendorConnectionId ?? sheet.vendorConnectionId;
  const [conn] = connId
    ? await tx.select().from(vendorConnections).where(eq(vendorConnections.id, connId)).limit(1)
    : await tx
        .select()
        .from(vendorConnections)
        .where(sql`${vendorConnections.status} <> 'paused'`)
        .orderBy(desc(vendorConnections.isDefault), asc(vendorConnections.createdAt))
        .limit(1);
  if (!conn)
    throw new ORPCError("NO_VENDOR", {
      status: 400,
      message: "No vendor connection; add one under Vendors",
    });
  if (conn.status === "paused") throw badRequest(`Vendor ${conn.name} is paused`);
  if (!sheet.pngKey && !sheet.pdfKey) throw badRequest("Sheet has no files yet");

  const portal = conn.delivery === "portal" && conn.status === "active" && !!conn.vendorCompanyId;
  if (portal && conn.vendorCompanyId) {
    await tx
      .insert(vendorAccess)
      .values({
        companyId: ctx.companyId,
        vendorCompanyId: conn.vendorCompanyId,
        gangSheetId: sheet.id,
        grantedBy: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [vendorAccess.companyId, vendorAccess.vendorCompanyId, vendorAccess.gangSheetId],
        set: { revokedAt: null, grantedAt: new Date() },
      });
  }
  const updated = await transitionSheet(tx, ctx.companyId, ctx.actor, sheet, "sent", {
    vendorConnectionId: conn.id,
    vendorNotes: input.note ?? null,
  });
  await emit(tx, ctx.companyId, "sheet.sent", {
    sheetId: sheet.id,
    vendorConnectionId: conn.id,
    delivery: portal ? "portal" : "email",
  });
  const [shop] = await tx
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  try {
    await vendorAdapter(portal ? "portal" : "email").deliver({
      companyId: ctx.companyId,
      sheetId: sheet.id,
      sheetName: sheet.name,
      shopName: shop?.name ?? "InvAI shop",
      vendor: { name: conn.name, email: conn.email, vendorCompanyId: conn.vendorCompanyId },
      lengthIn: updated.lengthIn,
      widthIn: updated.widthIn,
      transferCount: updated.transferCount,
      format: updated.pdfKey ? "pdf" : "png",
      note: input.note ?? null,
      links: portal
        ? { png: null, pdf: null, preview: null, expiresAt: new Date().toISOString() }
        : await sheetDownloadUrls(updated, EMAIL_LINK_TTL),
    });
  } catch (err) {
    log.warn("sheet delivery failed", { sheetId: sheet.id, error: String(err) });
    throw upstream(
      portal ? "vendor notification" : "email",
      String(err instanceof Error ? err.message : err),
    );
  }
  return getSheet(tx, ctx, sheet.id);
}

/* ------------------------------- vendor portal ------------------------------ */

/**
 * Acceptance: a vendor user opening the shop list (vendorPortal.shops, where invited shops are
 * listed) accepts every connection waiting on that vendor org.
 */
async function activatePending(vendorCompanyId: string) {
  await withSystem(async (stx) => {
    const rows = await stx
      .update(vendorConnections)
      .set({ status: "active", delivery: "portal", acceptedAt: new Date(), inviteToken: null })
      .where(
        and(
          eq(vendorConnections.vendorCompanyId, vendorCompanyId),
          eq(vendorConnections.status, "invited"),
        ),
      )
      .returning({ id: vendorConnections.id, companyId: vendorConnections.companyId });
    for (const r of rows)
      log.info("vendor connection activated", { connectionId: r.id, shop: r.companyId });
  });
}

type InboxRow = {
  sheet: typeof gangSheets.$inferSelect;
  shopName: string;
  vendorName: string | null;
  spec: SheetSpec | null;
};

function toInbox(r: InboxRow): VendorInboxSheet {
  return {
    ...toGangSheet(r.sheet, r.vendorName),
    shop: { orgId: r.sheet.companyId, name: r.shopName },
    spec: { ...DEFAULT_SHEET_SPEC, ...(r.spec ?? {}) },
  };
}

function inboxSelect(tx: Tx) {
  return tx
    .select({
      sheet: gangSheets,
      shopName: companies.name,
      vendorName: vendorConnections.name,
      spec: vendorConnections.spec,
    })
    .from(gangSheets)
    .innerJoin(companies, eq(companies.id, gangSheets.companyId))
    .leftJoin(vendorConnections, eq(vendorConnections.id, gangSheets.vendorConnectionId));
}

export type InboxInput = PageInput & {
  status?: SheetState[] | undefined;
  shopOrgId?: string | undefined;
};

export async function vendorInbox(ctx: TenantContext, input: InboxInput) {
  return withVendor(ctx.companyId, async (tx) => {
    const page = keyset(gangSheets.createdAt, gangSheets.id, input);
    const base: (SQL | undefined)[] = [
      // Only sheets explicitly granted; RLS enforces the same, this keeps the vendor's own rows out.
      sql`${gangSheets.companyId} <> ${ctx.companyId}`,
      input.shopOrgId ? eq(gangSheets.companyId, input.shopOrgId) : undefined,
    ];
    const filters = [
      ...base,
      page.where,
      input.status?.length ? inArray(gangSheets.status, input.status) : undefined,
    ];
    const rows = await inboxSelect(tx)
      .where(and(...filters))
      .orderBy(...page.orderBy)
      .limit(page.limit + 1);
    const countRows = await tx
      .select({ status: gangSheets.status, n: sql<number>`count(*)`.mapWith(Number) })
      .from(gangSheets)
      .where(and(...base))
      .groupBy(gangSheets.status);
    // Derived from SHEET_STATES (not hand-listed) so a future state can't silently drop out of
    // this exhaustive Record and fail output validation, as `printing` (T-6-2) just did.
    const counts = Object.fromEntries(
      SHEET_STATES.map((s) => [s, countRows.find((c) => c.status === s)?.n ?? 0]),
    ) as Record<SheetState, number>;
    const result = page.result(
      rows.map((r) => ({ ...r, createdAt: r.sheet.createdAt, id: r.sheet.id })),
      toInbox,
    );
    return { ...result, counts };
  });
}

async function inboxRow(tx: Tx, vendorCompanyId: string, id: string) {
  const [row] = await inboxSelect(tx)
    .where(and(eq(gangSheets.id, id), sql`${gangSheets.companyId} <> ${vendorCompanyId}`))
    .limit(1);
  if (!row) throw notFound("gang sheet", id);
  return row;
}

export async function vendorSheet(ctx: TenantContext, id: string) {
  return withVendor(ctx.companyId, async (tx) => {
    const row = await inboxRow(tx, ctx.companyId, id);
    return { ...toInbox(row), placements: await sheetPlacements(tx, id) };
  });
}

export async function vendorDownloadUrls(ctx: TenantContext, id: string) {
  return withVendor(ctx.companyId, async (tx) =>
    sheetDownloadUrls((await inboxRow(tx, ctx.companyId, id)).sheet),
  );
}

type PortalAction =
  | { kind: "acknowledge" }
  | { kind: "printed" }
  | { kind: "shipped"; carrier: string; trackingCode: string; note?: string | undefined }
  | { kind: "reject"; reason: string };

/**
 * A vendor status update: access is checked under the vendor's RLS, then the change is written
 * in the shop's tenant (audit + outbox + realtime to the shop) with the vendor user as actor.
 */
export async function vendorUpdate(
  ctx: TenantContext,
  id: string,
  action: PortalAction,
): Promise<VendorInboxSheet> {
  const visible = await withVendor(ctx.companyId, (tx) => inboxRow(tx, ctx.companyId, id));
  const shopId = visible.sheet.companyId;
  const actor: Actor = { kind: "user", userId: ctx.userId, ip: ctx.actor.ip ?? null };
  const vendorOrgId = ctx.companyId;
  await withTenant(shopId, async (tx) => {
    const sheet = await lockSheet(tx, id);
    const from = sheet.status;
    switch (action.kind) {
      case "acknowledge":
        if (from === "acknowledged") return;
        await transitionSheet(tx, shopId, actor, sheet, "acknowledged");
        await emit(tx, shopId, "sheet.acknowledged", { sheetId: id, vendorOrgId });
        break;
      case "printed":
        if (from === "printed") return;
        await transitionSheet(tx, shopId, actor, sheet, "printed");
        await emit(tx, shopId, "sheet.printed", { sheetId: id, vendorOrgId });
        break;
      case "shipped":
        if (from === "shipped") return;
        await transitionSheet(tx, shopId, actor, sheet, "shipped", {
          trackingCarrier: action.carrier,
          trackingCode: action.trackingCode,
          vendorNotes: action.note ?? sheet.vendorNotes,
        });
        await emit(tx, shopId, "sheet.shipped", {
          sheetId: id,
          vendorOrgId,
          trackingCode: action.trackingCode,
        });
        break;
      case "reject":
        if (!["sent", "acknowledged", "printed"].includes(from))
          throw conflict(`A ${from} sheet can't be rejected`);
        await transitionSheet(
          tx,
          shopId,
          actor,
          sheet,
          "failed",
          { error: `Vendor: ${action.reason}` },
          { force: true },
        );
        break;
    }
    const to = (await lockSheet(tx, id)).status;
    afterCommit(tx, () =>
      publish(vendorOrgId, { type: "sheet.status_changed", data: { sheetId: id, from, to } }).then(
        () => undefined,
      ),
    );
  });
  return withVendor(ctx.companyId, async (tx) => toInbox(await inboxRow(tx, ctx.companyId, id)));
}

export async function vendorShops(ctx: TenantContext): Promise<{ items: VendorShop[] }> {
  await activatePending(ctx.companyId);
  return withVendor(ctx.companyId, async (tx) => {
    const conns = await tx
      .select({ shopId: vendorConnections.companyId, name: companies.name })
      .from(vendorConnections)
      .innerJoin(companies, eq(companies.id, vendorConnections.companyId))
      .where(eq(vendorConnections.vendorCompanyId, ctx.companyId));
    const since = new Date(Date.now() - 30 * 86400_000);
    const stats = await tx
      .select({
        shopId: gangSheets.companyId,
        open: sql<number>`count(*) filter (where ${gangSheets.status} in ('sent','acknowledged','printed'))`.mapWith(
          Number,
        ),
        total: sql<number>`count(*)`.mapWith(Number),
        inches:
          sql<number>`coalesce(sum(${gangSheets.lengthIn}) filter (where ${gangSheets.createdAt} >= ${since}), 0)`.mapWith(
            Number,
          ),
        last: sql<string | null>`max(${gangSheets.createdAt})::text`,
      })
      .from(gangSheets)
      .where(sql`${gangSheets.companyId} <> ${ctx.companyId}`)
      .groupBy(gangSheets.companyId);
    const byShop = new Map(stats.map((s) => [s.shopId, s]));
    const seen = new Set<string>();
    const items: VendorShop[] = [];
    for (const c of conns) {
      if (seen.has(c.shopId)) continue;
      seen.add(c.shopId);
      const s = byShop.get(c.shopId);
      items.push({
        orgId: c.shopId,
        name: c.name,
        sheetsOpen: s?.open ?? 0,
        sheetsTotal: s?.total ?? 0,
        inchesLast30d: Math.round((s?.inches ?? 0) * 100) / 100,
        lastSheetAt: s?.last ? new Date(s.last).toISOString() : null,
      });
    }
    return { items };
  });
}
