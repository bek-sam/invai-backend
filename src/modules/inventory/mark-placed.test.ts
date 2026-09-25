import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { blankVariants } from "../../db/schema";
import { createCompany, createLocation, createUser, tenantContext } from "../../test/fixtures";
import * as svc from "./service";

/*
 * T-6-1 AC2: marking a PO placed by hand (B-86), for suppliers with no ordering API. Pure state
 * transition, no outbound call, so it's naturally idempotent.
 */
describe("markPlacedPo", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let blankId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    await createLocation(companyId);
    const [row] = await withSystem((tx) =>
      tx
        .insert(blankVariants)
        .values({
          companyId,
          brand: "Gildan",
          style: "Softstyle",
          styleCode: "G64000",
          color: "Black",
          colorCode: "BLK",
          size: "M",
          sizeCode: "M",
          sku: "G64000-BLK-M",
          supplierSku: "B100M",
          costCents: 300,
        })
        .returning(),
    );
    blankId = (row as { id: string }).id;
  });

  async function draftPo() {
    return withTenant(companyId, (tx) =>
      svc.createPo(tx, ctx, {
        supplier: "other",
        lines: [{ blankVariantId: blankId, qty: 5 }],
        freight: 0,
        expectedAt: null,
        notes: null,
      }),
    );
  }

  it("moves a draft to submitted with the given ref", async () => {
    const po = await draftPo();
    const placed = await withTenant(companyId, (tx) =>
      svc.markPlacedPo(tx, ctx, { id: po.id, supplierOrderRef: "PHONE-123" }),
    );
    expect(placed.status).toBe("submitted");
    expect(placed.supplierOrderId).toBe("PHONE-123");
    expect(placed.submittedAt).not.toBeNull();
  });

  it("is a safe no-op retried with the same ref", async () => {
    const po = await draftPo();
    const first = await withTenant(companyId, (tx) =>
      svc.markPlacedPo(tx, ctx, { id: po.id, supplierOrderRef: "PHONE-1" }),
    );
    const again = await withTenant(companyId, (tx) =>
      svc.markPlacedPo(tx, ctx, { id: po.id, supplierOrderRef: "PHONE-1" }),
    );
    expect(again).toMatchObject({ status: "submitted", supplierOrderId: "PHONE-1" });
    expect(again.submittedAt).toBe(first.submittedAt);
  });

  it("rejects a different ref once already submitted (INVALID_TRANSITION)", async () => {
    const po = await draftPo();
    await withTenant(companyId, (tx) =>
      svc.markPlacedPo(tx, ctx, { id: po.id, supplierOrderRef: "PHONE-1" }),
    );
    await expect(
      withTenant(companyId, (tx) =>
        svc.markPlacedPo(tx, ctx, { id: po.id, supplierOrderRef: "PHONE-2" }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("rejects marking a cancelled PO placed", async () => {
    const po = await draftPo();
    await svc.cancelPo(ctx, po.id);
    await expect(
      withTenant(companyId, (tx) =>
        svc.markPlacedPo(tx, ctx, { id: po.id, supplierOrderRef: "PHONE-1" }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
});
