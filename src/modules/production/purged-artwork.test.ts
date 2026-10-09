import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { blankVariants, designs, orderItems, vendorConnections } from "../../db/schema";
import { DEFAULT_SHEET_SPEC } from "../../db/schema/vendors";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { createNameTemplate, seedItemArt } from "../privacy/buyer-text.fixtures";
import { redactBuyerText } from "../privacy/service";

/*
 * T-29-1 (decision 0027): purged artwork never reaches a sheet. The existing eligibility check
 * (sheets.ts `classify`: a personalized unit needs a rendered or approved key) is the guard; a
 * purged unit still in production, or reprinted, shows `needs_artwork` in the batch preview.
 */

type NestReq = { items: { id: string; width_in: number; height_in: number }[] };
const imagingMock = vi.hoisted(() => ({
  nest: vi.fn(async (req: NestReq) => {
    let y = 0.25;
    const placements = req.items.map((i) => {
      const p = {
        id: i.id,
        copy: 0,
        x_in: 0.25,
        y_in: y,
        width_in: i.width_in,
        height_in: i.height_in,
        rotated: false,
      };
      y += i.height_in + 0.6;
      return p;
    });
    return { sheets: [{ index: 0, length_in: y + 0.25, utilization: 0.5, placements }] };
  }),
}));
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return { ...actual, imaging: { ...actual.imaging, ...imagingMock } };
});

const svc = await import("./service");

describe("purged artwork and the batch preview", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let orderId: string;
  let readyId: string;
  let reprintId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    ctx = tenantContext(companyId, (await createUser(companyId, "owner")).id, "owner");
    await createLocation(companyId);
    const conn = await createConnection(companyId);
    const tpl = await createNameTemplate(companyId);
    const { order, items } = await createOrder(companyId, conn.id, { units: 2, state: "ready" });
    orderId = order.id;
    readyId = items[0]?.id as string;
    reprintId = items[1]?.id as string;
    await withSystem(async (tx) => {
      await tx.insert(vendorConnections).values({
        companyId,
        name: "Test DTF",
        email: "dtf@test.local",
        status: "active",
        delivery: "email",
        spec: DEFAULT_SHEET_SPEC,
        isDefault: true,
      });
      const [design] = await tx
        .insert(designs)
        .values({ companyId, code: "N100", name: "Name tee", personalizationTemplateId: tpl.id })
        .returning();
      const [blank] = await tx
        .insert(blankVariants)
        .values({
          companyId,
          brand: "Gildan",
          style: "64000",
          styleCode: "64000",
          color: "Black",
          colorCode: "BLK",
          size: "M",
          sizeCode: "M",
          sku: "G64000-BLK-M",
        })
        .returning();
      if (!design || !blank) throw new Error("setup");
      const base = {
        designId: design.id,
        blankVariantId: blank.id,
        placement: "front",
        printWidthIn: 10,
        printHeightIn: 12,
      };
      await tx.update(orderItems).set(base).where(eq(orderItems.id, readyId));
      // A reprint waits on_sheet with no transfer.
      await tx
        .update(orderItems)
        .set({ ...base, state: "on_sheet", isReprint: true, transferId: null })
        .where(eq(orderItems.id, reprintId));
    });
    await seedItemArt(companyId, readyId, tpl.id);
    await seedItemArt(companyId, reprintId, tpl.id);
  });

  const opts = {
    dueBefore: new Date(Date.now() + 5 * 86400_000).toISOString(),
    rushFirst: true,
    includeReprints: true,
    vendorConnectionId: null,
    maxSheets: null,
  };

  it("a purged unit in production or reprinted shows needs_artwork and never goes on a sheet", async () => {
    const before = await withTenant(companyId, (tx) => svc.previewBatch(tx, ctx, opts));
    expect(before.items.map((i) => i.orderItemId).sort()).toEqual([readyId, reprintId].sort());

    await withTenant(companyId, (tx) => redactBuyerText(tx, [orderId], { scope: "all" }));

    const after = await withTenant(companyId, (tx) => svc.previewBatch(tx, ctx, opts));
    expect(after.items).toEqual([]);
    expect(after.excluded.map((e) => [e.orderItemId, e.reason]).sort()).toEqual(
      [
        [readyId, "needs_artwork"],
        [reprintId, "needs_artwork"],
      ].sort(),
    );
  });
});
