import { SHEET_STATES } from "@invai/contracts";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withSystem, withTenant } from "../../db/client";
import { gangSheetBatches, gangSheets, vendorAccess, vendorConnections } from "../../db/schema";
import { DEFAULT_SHEET_SPEC } from "../../db/schema/vendors";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("../../integrations/vendors/mailer", async (orig) => ({
  ...(await orig<typeof import("../../integrations/vendors/mailer")>()),
  sendMail: vi.fn(async (m: { to: string; subject: string; text: string }) => {
    sent.push(m);
    return { messageId: `<${sent.length}@test>` };
  }),
}));

const svc = await import("./service");

describe("vendors: delivery and the vendor portal", () => {
  let shopId: string;
  let vendorOrgId: string;
  let otherVendorOrgId: string;
  let ownerCtx: ReturnType<typeof tenantContext>;
  let vendorCtx: ReturnType<typeof tenantContext>;
  let otherVendorCtx: ReturnType<typeof tenantContext>;
  let sheetId: string;

  beforeAll(async () => {
    shopId = (await createCompany({ name: "Shop A" })).id;
    vendorOrgId = (await createCompany({ name: "DTF A", type: "vendor" })).id;
    otherVendorOrgId = (await createCompany({ name: "DTF B", type: "vendor" })).id;
    const owner = await createUser(shopId, "owner");
    const vendorUser = await createUser(vendorOrgId, "vendor");
    const otherUser = await createUser(otherVendorOrgId, "vendor");
    ownerCtx = tenantContext(shopId, owner.id, "owner");
    vendorCtx = tenantContext(vendorOrgId, vendorUser.id, "vendor", "vendor");
    otherVendorCtx = tenantContext(otherVendorOrgId, otherUser.id, "vendor", "vendor");
    await withSystem(async (tx) => {
      await tx.insert(vendorConnections).values({
        companyId: shopId,
        vendorCompanyId: vendorOrgId,
        name: "DTF A",
        email: "a@dtf.test",
        status: "active",
        delivery: "portal",
        spec: DEFAULT_SHEET_SPEC,
        isDefault: true,
      });
      const [batch] = await tx
        .insert(gangSheetBatches)
        .values({ companyId: shopId, name: "b" })
        .returning();
      const [sheet] = await tx
        .insert(gangSheets)
        .values({
          companyId: shopId,
          batchId: batch?.id as string,
          name: "2026-09-24 #1",
          status: "ready",
          lengthIn: 100,
          pngKey: `${shopId}/sheet/x.png`,
          previewKey: `${shopId}/preview/x.png`,
        })
        .returning();
      sheetId = sheet?.id as string;
    });
  });

  it("sends through the portal: grant + notification, sheet ready -> sent", async () => {
    const sheet = await withTenant(shopId, (tx) =>
      svc.sendSheetToVendor(tx, ownerCtx, { id: sheetId, note: "rush" }),
    );
    expect(sheet).toMatchObject({ status: "sent", vendorName: "DTF A" });
    const grants = await withSystem((tx) =>
      tx.select().from(vendorAccess).where(eq(vendorAccess.gangSheetId, sheetId)),
    );
    expect(grants).toEqual([
      expect.objectContaining({ vendorCompanyId: vendorOrgId, revokedAt: null }),
    ]);
    expect(sent.at(-1)).toMatchObject({ to: "a@dtf.test" });
    expect(sent.at(-1)?.text).not.toContain("X-Amz-Signature"); // portal mail carries no file links
  });

  it("shows the sheet only to the granted vendor (RLS) and walks it to shipped", async () => {
    const inbox = await svc.vendorInbox(vendorCtx, { limit: 10 });
    expect(inbox.items.map((s) => s.id)).toEqual([sheetId]);
    expect(inbox.items[0]?.shop.name).toBe("Shop A");
    expect(inbox.counts.sent).toBe(1);
    // counts is an exhaustive Record<SheetState, number> (contract: z.record(z.enum(SHEET_STATES),
    // ...)) -- a missing key (e.g. `printing`, dropped once from a hand-listed array) fails this
    // parse the same way it fails at the oRPC output-validation layer (a 500 for every caller).
    expect(() =>
      z.record(z.enum(SHEET_STATES), z.number().int().nonnegative()).parse(inbox.counts),
    ).not.toThrow();
    expect(Object.keys(inbox.counts).sort()).toEqual([...SHEET_STATES].sort());
    const other = await svc.vendorInbox(otherVendorCtx, { limit: 10 });
    expect(other.items).toHaveLength(0);
    await expect(svc.vendorSheet(otherVendorCtx, sheetId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect((await svc.vendorUpdate(vendorCtx, sheetId, { kind: "acknowledge" })).status).toBe(
      "acknowledged",
    );
    expect((await svc.vendorUpdate(vendorCtx, sheetId, { kind: "printed" })).status).toBe(
      "printed",
    );
    const shipped = await svc.vendorUpdate(vendorCtx, sheetId, {
      kind: "shipped",
      carrier: "ups",
      trackingCode: "1Z999",
    });
    expect(shipped).toMatchObject({
      status: "shipped",
      tracking: { carrier: "ups", code: "1Z999" },
    });
    await expect(
      svc.vendorUpdate(vendorCtx, sheetId, { kind: "reject", reason: "late" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const shops = await svc.vendorShops(vendorCtx);
    expect(shops.items).toEqual([expect.objectContaining({ orgId: shopId, sheetsTotal: 1 })]);
  });

  it("refuses to remove a vendor with open sheets", async () => {
    const list = await withTenant(shopId, (tx) => svc.listConnections(tx, ownerCtx));
    const conn = list.items[0];
    expect(conn?.sheetsOpen).toBe(1);
    await expect(
      withTenant(shopId, (tx) => svc.removeConnection(tx, ownerCtx, conn?.id as string)),
    ).rejects.toMatchObject({ code: "VENDOR_HAS_OPEN_SHEETS" });
  });
});
