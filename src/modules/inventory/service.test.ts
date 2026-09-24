import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { blankVariants } from "../../db/schema";
import { createCompany, createLocation, createUser, tenantContext } from "../../test/fixtures";
import * as svc from "./service";

describe("inventory service", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let blankIds: string[];

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    await createLocation(companyId);
    const rows = await withSystem((tx) =>
      tx
        .insert(blankVariants)
        .values(
          ["S", "M", "L"].map((size) => ({
            companyId,
            brand: "Gildan",
            style: "Softstyle",
            styleCode: "G64000",
            color: "White",
            colorCode: "WHT",
            size,
            sizeCode: size,
            sku: `G64000-WHT-${size}`,
            supplierSku: `B000${size}`,
            costCents: 250,
            reorderPoint: 10,
          })),
        )
        .returning(),
    );
    blankIds = rows.map((r) => r.id);
  });

  it("adjusts and counts with variance movements", async () => {
    const [a] = blankIds as [string];
    await withTenant(companyId, (tx) =>
      svc.adjust(tx, ctx, { blankVariantId: a, qty: 12, reason: "found", note: null }),
    );
    const res = await withTenant(companyId, (tx) =>
      svc.count(tx, ctx, { lines: [{ blankVariantId: a, counted: 9 }], note: "cycle" }),
    );
    expect(res.variance[0]).toMatchObject({ expected: 12, counted: 9, delta: -3 });
    expect(res.movements[0]).toMatchObject({ kind: "count", qty: -3 });
    const stock = await withTenant(companyId, (tx) => svc.getStock(tx, ctx, { blankVariantId: a }));
    expect(stock).toMatchObject({
      onHand: 9,
      available: 9,
      reorderPoint: 10,
      belowReorderPoint: true,
    });
  });

  it("suggests, creates, submits and partially receives a PO", async () => {
    const sugg = await withTenant(companyId, (tx) => svc.reorderSuggestions(tx, ctx, {}));
    const ss = sugg.items.find((s) => s.supplier === "ssactivewear");
    expect(ss?.lines.length).toBeGreaterThan(0);
    // No velocity: manual points only, still padded toward $200 by whatever is below its point.
    expect(ss?.freeFreightThreshold).toBe(20000);

    const po = await withTenant(companyId, (tx) =>
      svc.createPoFromSuggestion(tx, ctx, {
        supplier: "ssactivewear",
        lines: blankIds.map((id) => ({ blankVariantId: id, qty: 40 })),
      }),
    );
    expect(po.status).toBe("draft");
    expect(po.subtotal).toBe(3 * 40 * 250);
    expect(po.freight).toBe(0);

    const submitted = await withTenant(companyId, (tx) => svc.submitPo(tx, ctx, po.id));
    expect(submitted.status).toBe("submitted");
    expect(submitted.supplierOrderId).toMatch(/^MOCK-SSA-/);

    const incoming = await withTenant(companyId, (tx) =>
      svc.getStock(tx, ctx, { blankVariantId: blankIds[1] as string }),
    );
    expect(incoming.incoming).toBe(40);

    const line = submitted.lines.find((l) => l.blankVariantId === blankIds[1]);
    const partial = await withTenant(companyId, (tx) =>
      svc.receivePo(tx, ctx, {
        purchaseOrderId: po.id,
        lines: [{ lineId: line?.id as string, qty: 25 }],
        note: null,
      }),
    );
    expect(partial.status).toBe("partially_received");
    const after = await withTenant(companyId, (tx) =>
      svc.getStock(tx, ctx, { blankVariantId: blankIds[1] as string }),
    );
    expect(after).toMatchObject({ onHand: 25, available: 25, incoming: 15 });

    await expect(
      withTenant(companyId, (tx) =>
        svc.receivePo(tx, ctx, {
          purchaseOrderId: po.id,
          lines: [{ lineId: line?.id as string, qty: 16 }],
          note: null,
        }),
      ),
    ).rejects.toThrow(/outstanding/);

    const rest = await withTenant(companyId, (tx) =>
      svc.receivePo(tx, ctx, {
        purchaseOrderId: po.id,
        lines: submitted.lines.map((l) => ({
          lineId: l.id,
          qty: l.id === line?.id ? 15 : 40,
        })),
        note: null,
      }),
    );
    expect(rest.status).toBe("received");
    const moves = await withTenant(companyId, (tx) =>
      svc.listMovements(tx, ctx, { limit: 50, kind: ["receive"] }),
    );
    expect(moves.items).toHaveLength(4);
  });

  it("lists suppliers and live (mock) supplier stock", async () => {
    const list = await withTenant(companyId, (tx) => svc.listSuppliers(tx, ctx));
    expect(list.items.find((s) => s.supplier === "ssactivewear")).toMatchObject({
      provider: "mock",
      variantCount: 3,
    });
    const stock = await withTenant(companyId, (tx) => svc.suppliersStock(tx, ctx, blankIds));
    expect(stock.items.every((i) => typeof i.supplierStock === "number")).toBe(true);
  });
});
