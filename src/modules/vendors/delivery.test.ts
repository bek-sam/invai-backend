import type { Role } from "@invai/contracts";
import { call } from "@orpc/server";
import { UnrecoverableError } from "bullmq";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { withSystem, withTenant } from "../../db/client";
import {
  alerts,
  gangSheetBatches,
  gangSheets,
  outboxEvents,
  vendorConnections,
  vendorSheetDeliveries,
} from "../../db/schema";
import { DEFAULT_SHEET_SPEC } from "../../db/schema/vendors";
import { runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";

/*
 * B-102 (T-22-5): the vendor sheet email goes out from a job after the commit, once per
 * delivery row, and `vendors.sheets.resendEmail` sends again at most once per 10 minutes.
 */

const mail = vi.hoisted(() => ({
  sent: [] as { to: string; subject: string; text: string }[],
  failNext: null as null | Record<string, unknown>,
}));
vi.mock("../../integrations/vendors/mailer", async (orig) => ({
  ...(await orig<typeof import("../../integrations/vendors/mailer")>()),
  sendMail: vi.fn(async (m: { to: string; subject: string; text: string }) => {
    if (mail.failNext) {
      const err = Object.assign(new Error("smtp refused"), mail.failNext);
      mail.failNext = null;
      throw err;
    }
    mail.sent.push(m);
    return { messageId: `<${mail.sent.length}@test>` };
  }),
}));

// A worker that dies while the links are built: the promise never settles (a test double for
// production's unit, not ours).
const links = vi.hoisted(() => ({ hang: false, reached: null as null | (() => void) }));
vi.mock("../production/service", async (orig) => {
  const real = await orig<typeof import("../production/service")>();
  return {
    ...real,
    sheetDownloadUrls: vi.fn((...args: Parameters<typeof real.sheetDownloadUrls>) => {
      if (links.hang) {
        links.hang = false;
        links.reached?.();
        return new Promise<never>(() => {});
      }
      return real.sheetDownloadUrls(...args);
    }),
  };
});

const svc = await import("./service");
const { deliverSheetJob } = await import("./jobs");
const { router } = await import("../../api/router");

function as(companyId: string, userId: string, role: Role): Context {
  return {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: userId, name: role, email: `${role}@test.local` },
    companyId,
    orgType: "shop",
    role,
    permissions: permissionsFor(role),
  };
}

let shopId: string;
let otherShopId: string;
let ownerId: string;
let officeId: string;
let presserId: string;
let ownerCtx: ReturnType<typeof tenantContext>;
let emailConnId: string;
let portalConnId: string;
let n = 0;

async function readySheet(companyId = shopId) {
  return withSystem(async (tx) => {
    const [batch] = await tx.insert(gangSheetBatches).values({ companyId, name: "b" }).returning();
    const [sheet] = await tx
      .insert(gangSheets)
      .values({
        companyId,
        batchId: batch?.id as string,
        name: `2026-09-29 #${++n}`,
        status: "ready",
        lengthIn: 120,
        transferCount: 14,
        pngKey: `${companyId}/sheet/${n}.png`,
      })
      .returning();
    return sheet?.id as string;
  });
}

const deliveries = (sheetId: string) =>
  withSystem((tx) =>
    tx
      .select()
      .from(vendorSheetDeliveries)
      .where(eq(vendorSheetDeliveries.gangSheetId, sheetId))
      .orderBy(vendorSheetDeliveries.seq),
  );

const alertsFor = (sheetId: string) =>
  withSystem((tx) => tx.select().from(alerts).where(eq(alerts.entityId, sheetId)));

const send = (sheetId: string, vendorConnectionId = emailConnId) =>
  withTenant(shopId, (tx) =>
    svc.sendSheetToVendor(tx, ownerCtx, { id: sheetId, vendorConnectionId }),
  );

const deliver = (sheetId: string, run: { attempt?: number; attempts?: number } = {}) =>
  runJobInline(deliverSheetJob, { companyId: shopId, sheetId }, run);

beforeAll(async () => {
  shopId = (await createCompany({ name: "Shop Deliveries" })).id;
  otherShopId = (await createCompany({ name: "Shop Other" })).id;
  const vendorOrgId = (await createCompany({ name: "DTF Portal", type: "vendor" })).id;
  ownerId = (await createUser(shopId, "owner")).id;
  officeId = (await createUser(shopId, "office")).id;
  presserId = (await createUser(shopId, "presser")).id;
  ownerCtx = tenantContext(shopId, ownerId, "owner");
  await withSystem(async (tx) => {
    const [email] = await tx
      .insert(vendorConnections)
      .values({
        companyId: shopId,
        name: "DTF Mail",
        email: "mail@dtf.test",
        status: "invited",
        delivery: "email",
        spec: DEFAULT_SHEET_SPEC,
      })
      .returning();
    const [portal] = await tx
      .insert(vendorConnections)
      .values({
        companyId: shopId,
        vendorCompanyId: vendorOrgId,
        name: "DTF Portal",
        email: "portal@dtf.test",
        status: "active",
        delivery: "portal",
        spec: DEFAULT_SHEET_SPEC,
      })
      .returning();
    emailConnId = email?.id as string;
    portalConnId = portal?.id as string;
  });
});

beforeEach(() => {
  mail.sent.length = 0;
  mail.failNext = null;
  links.hang = false;
  links.reached = null;
});

describe("sheet email after commit (B-102)", () => {
  it("sends nothing inside the transaction; the job sends once, a second run sends nothing", async () => {
    const sheetId = await readySheet();
    const sheet = await send(sheetId);
    expect(sheet.status).toBe("sent");
    expect(mail.sent).toHaveLength(0);
    expect(await deliveries(sheetId)).toEqual([
      expect.objectContaining({ seq: 1, status: "pending", delivery: "email" }),
    ]);
    const events = await withSystem((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.companyId, shopId)),
    );
    expect(
      events.filter((e) => e.name === "sheet.sent" && e.payload.sheetId === sheetId),
    ).toHaveLength(1);

    expect(await deliver(sheetId)).toMatchObject({ status: "sent" });
    expect(await deliver(sheetId)).toEqual({ status: "skipped", reason: "nothing_pending" });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "mail@dtf.test" });
    expect(mail.sent[0]?.text).toContain("X-Amz-Signature"); // email carries signed links
    expect(await deliveries(sheetId)).toEqual([
      expect.objectContaining({ status: "sent", attempts: 1, messageId: "<1@test>" }),
    ]);
  });

  it("a rolled-back send leaves no delivery and no email", async () => {
    const sheetId = await readySheet();
    await expect(
      withTenant(shopId, async (tx) => {
        await svc.sendSheetToVendor(tx, ownerCtx, { id: sheetId, vendorConnectionId: emailConnId });
        throw new Error("boom after send");
      }),
    ).rejects.toThrow("boom after send");
    expect(await deliveries(sheetId)).toEqual([]);
    expect(await deliver(sheetId)).toEqual({ status: "skipped", reason: "nothing_pending" });
    expect(mail.sent).toHaveLength(0);
  });

  it("an attempt that died mid-send is never re-sent automatically", async () => {
    const sheetId = await readySheet();
    await send(sheetId);
    const [row] = await deliveries(sheetId);
    // The worker claimed the row, then died before recording the result.
    await withSystem((tx) =>
      tx
        .update(vendorSheetDeliveries)
        .set({ status: "sending", claimedAt: new Date(), attempts: 1 })
        .where(eq(vendorSheetDeliveries.id, row?.id as string)),
    );
    // Still inside the send timeout: another attempt may be in flight.
    expect(await deliver(sheetId)).toEqual({ status: "skipped", reason: "in_flight" });
    await withSystem((tx) =>
      tx
        .update(vendorSheetDeliveries)
        .set({ claimedAt: new Date(Date.now() - 5 * 60_000) })
        .where(eq(vendorSheetDeliveries.id, row?.id as string)),
    );
    expect(await deliver(sheetId)).toMatchObject({ status: "unknown" });
    expect(await deliver(sheetId)).toEqual({ status: "skipped", reason: "nothing_pending" });
    expect(mail.sent).toHaveLength(0);
    expect((await deliveries(sheetId))[0]?.status).toBe("unknown");

    // The office hears about it: one open alert for this delivery, linking to the sheet.
    const [alert, ...more] = await alertsFor(sheetId);
    expect(more).toHaveLength(0);
    expect(alert).toMatchObject({
      status: "open",
      entityType: "gang_sheet",
      dedupeKey: `vendor-sheet-delivery-${row?.id}`,
      data: expect.objectContaining({ outcome: "unknown", messageEs: expect.any(String) }),
    });
    expect(alert?.title).toContain("may not have gone out");
    // Ending the same row again (a replayed stale claim) doesn't add a second alert.
    await withSystem((tx) =>
      tx
        .update(vendorSheetDeliveries)
        .set({ status: "sending", claimedAt: new Date(Date.now() - 5 * 60_000) })
        .where(eq(vendorSheetDeliveries.id, row?.id as string)),
    );
    expect(await deliver(sheetId)).toMatchObject({ status: "unknown" });
    expect(await alertsFor(sheetId)).toHaveLength(1);
    // The resend stays limited: the unknown attempt may have reached the vendor.
    await expect(
      withTenant(shopId, (tx) => svc.resendSheetEmail(tx, ownerCtx, { sheetId })),
    ).rejects.toMatchObject({ code: "RESEND_TOO_SOON", status: 429 });
    expect(mail.sent).toHaveLength(0);
  });

  it("a worker killed before the send leaves the row pending; the retry sends exactly one", async () => {
    const sheetId = await readySheet();
    await send(sheetId);
    const reached = new Promise<void>((resolve) => {
      links.reached = resolve;
    });
    links.hang = true;
    // The first attempt stops for good while building the links (worker killed): never awaited.
    void deliver(sheetId);
    await reached;
    expect(await deliveries(sheetId)).toEqual([
      expect.objectContaining({ status: "pending", attempts: 0, claimedAt: null }),
    ]);
    expect(await deliver(sheetId)).toMatchObject({ status: "sent" });
    expect(await deliver(sheetId)).toEqual({ status: "skipped", reason: "nothing_pending" });
    expect(mail.sent).toHaveLength(1);
    expect(await deliveries(sheetId)).toEqual([
      expect.objectContaining({ status: "sent", attempts: 1 }),
    ]);
    expect(await alertsFor(sheetId)).toHaveLength(0);
  });

  it("an SMTP refusal retries and sends once; a 5xx fails for good", async () => {
    const sheetId = await readySheet();
    await send(sheetId);
    mail.failNext = { code: "ECONNECTION" };
    await expect(deliver(sheetId, { attempt: 1, attempts: 5 })).rejects.toThrow(
      "sheet delivery failed: ECONNECTION",
    );
    expect((await deliveries(sheetId))[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(await deliver(sheetId, { attempt: 2, attempts: 5 })).toMatchObject({ status: "sent" });
    expect(mail.sent).toHaveLength(1);
    expect(await alertsFor(sheetId)).toHaveLength(0); // a retried refusal isn't lost

    const bad = await readySheet();
    await send(bad);
    mail.failNext = { code: "EENVELOPE", responseCode: 550 };
    await expect(deliver(bad, { attempt: 1, attempts: 5 })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    const [row] = await deliveries(bad);
    expect(row).toMatchObject({ status: "failed", lastError: "EENVELOPE 550" });
    expect(mail.sent).toHaveLength(1);
    const failedAlerts = await alertsFor(bad);
    expect(failedAlerts).toHaveLength(1);
    expect(failedAlerts[0]).toMatchObject({
      status: "open",
      dedupeKey: `vendor-sheet-delivery-${row?.id}`,
      data: expect.objectContaining({ outcome: "failed", reason: "EENVELOPE 550" }),
    });
    expect(failedAlerts[0]?.title).toContain("didn't go out");
    // Nothing went out, so a resend is allowed at once.
    await withTenant(shopId, (tx) => svc.resendSheetEmail(tx, ownerCtx, { sheetId: bad }));
    expect(await deliver(bad)).toMatchObject({ status: "sent" });
    expect(mail.sent).toHaveLength(2);
    expect(await alertsFor(bad)).toHaveLength(1);

    // A refusal on the last attempt also ends `failed`, with its own single alert.
    const last = await readySheet();
    await send(last);
    mail.failNext = { code: "ECONNECTION" };
    await expect(deliver(last, { attempt: 5, attempts: 5 })).rejects.toThrow("ECONNECTION");
    expect((await deliveries(last))[0]).toMatchObject({ status: "failed" });
    expect(await deliver(last)).toEqual({ status: "skipped", reason: "nothing_pending" });
    expect(await alertsFor(last)).toHaveLength(1);
  });

  it("portal delivery also goes out from the job, once", async () => {
    const sheetId = await readySheet();
    await send(sheetId, portalConnId);
    expect(mail.sent).toHaveLength(0);
    expect(await deliver(sheetId)).toMatchObject({ status: "sent" });
    expect(await deliver(sheetId)).toMatchObject({ status: "skipped" });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.text).not.toContain("X-Amz-Signature");
  });
});

describe("vendors.sheets.resendEmail", () => {
  it("refuses a resend inside 10 minutes, then sends one more email", async () => {
    const sheetId = await readySheet();
    await send(sheetId);
    await deliver(sheetId);
    const [first] = await deliveries(sheetId);
    const sentAt = first?.sentAt as Date;

    const soon = new Date(sentAt.getTime() + 4 * 60_000);
    await expect(
      withTenant(shopId, (tx) => svc.resendSheetEmail(tx, ownerCtx, { sheetId }, soon)),
    ).rejects.toMatchObject({
      code: "RESEND_TOO_SOON",
      status: 429,
      data: { retryAfterSec: 360, lastSentAt: sentAt.toISOString() },
    });

    const later = new Date(sentAt.getTime() + 11 * 60_000);
    const out = await withTenant(shopId, (tx) =>
      svc.resendSheetEmail(tx, ownerCtx, { sheetId }, later),
    );
    expect(out).toEqual({ sheetId, sentAt: later.toISOString() });
    // A second click right after is refused (counted from the request, not the delivery).
    await expect(
      withTenant(shopId, (tx) =>
        svc.resendSheetEmail(tx, ownerCtx, { sheetId }, new Date(later.getTime() + 1_000)),
      ),
    ).rejects.toMatchObject({ code: "RESEND_TOO_SOON", data: { retryAfterSec: 599 } });
    const resendEvents = await withSystem((tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.companyId, shopId),
            eq(outboxEvents.name, "vendor.sheet_resend_requested"),
          ),
        ),
    );
    expect(resendEvents.filter((e) => e.payload.sheetId === sheetId)).toHaveLength(1);

    expect(await deliver(sheetId)).toMatchObject({ status: "sent" });
    expect(await deliver(sheetId)).toMatchObject({ status: "skipped" });
    expect(mail.sent).toHaveLength(2);
    expect((await deliveries(sheetId)).map((d) => [d.seq, d.status])).toEqual([
      [1, "sent"],
      [2, "sent"],
    ]);
  });

  it("answers SHEET_NOT_SENT, VENDOR_USES_PORTAL and NOT_FOUND for another shop", async () => {
    const ready = await readySheet();
    await expect(
      withTenant(shopId, (tx) => svc.resendSheetEmail(tx, ownerCtx, { sheetId: ready })),
    ).rejects.toMatchObject({ code: "SHEET_NOT_SENT", status: 409 });

    const portal = await readySheet();
    await send(portal, portalConnId);
    await expect(
      withTenant(shopId, (tx) => svc.resendSheetEmail(tx, ownerCtx, { sheetId: portal })),
    ).rejects.toMatchObject({ code: "VENDOR_USES_PORTAL", status: 409 });

    const otherOwner = await createUser(otherShopId, "owner");
    await expect(
      withTenant(otherShopId, (tx) =>
        svc.resendSheetEmail(tx, tenantContext(otherShopId, otherOwner.id, "owner"), {
          sheetId: portal,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("through the router: office may resend, presser is refused", async () => {
    const sheetId = await readySheet();
    await send(sheetId);
    await withSystem((tx) =>
      tx
        .update(vendorSheetDeliveries)
        .set({
          status: "sent",
          sentAt: new Date(Date.now() - 20 * 60_000),
          createdAt: new Date(Date.now() - 20 * 60_000),
        })
        .where(eq(vendorSheetDeliveries.gangSheetId, sheetId)),
    );
    await expect(
      call(
        router.vendors.sheets.resendEmail,
        { sheetId },
        { context: as(shopId, presserId, "presser") },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const out = await call(
      router.vendors.sheets.resendEmail,
      { sheetId },
      { context: as(shopId, officeId, "office") },
    );
    expect(out.sheetId).toBe(sheetId);
    await expect(
      call(
        router.vendors.sheets.resendEmail,
        { sheetId },
        { context: as(shopId, officeId, "office") },
      ),
    ).rejects.toMatchObject({ code: "RESEND_TOO_SOON" });
  });
});

describe("vendor_sheet_deliveries tenancy", () => {
  it("another shop can't read the rows or point a row at this shop's sheet", async () => {
    const sheetId = await readySheet();
    await send(sheetId);
    const seen = await withTenant(otherShopId, (tx) =>
      tx.select().from(vendorSheetDeliveries).where(eq(vendorSheetDeliveries.gangSheetId, sheetId)),
    );
    expect(seen).toEqual([]);
    // Composite FK: a row of the other shop can't reference this shop's sheet or connection.
    await expect(
      withSystem((tx) =>
        tx.insert(vendorSheetDeliveries).values({
          companyId: otherShopId,
          gangSheetId: sheetId,
          vendorConnectionId: emailConnId,
          delivery: "email",
          seq: 9,
        }),
      ),
    ).rejects.toThrow();
    // RLS WITH CHECK: inside shop B's tenant a row claiming shop A is refused.
    await expect(
      withTenant(otherShopId, (tx) =>
        tx.insert(vendorSheetDeliveries).values({
          companyId: shopId,
          gangSheetId: sheetId,
          vendorConnectionId: emailConnId,
          delivery: "email",
          seq: 9,
        }),
      ),
    ).rejects.toThrow();
  });
});
