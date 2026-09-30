import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { blankVariants } from "../../db/schema";
import { createCompany, createLocation, createUser, tenantContext } from "../../test/fixtures";
import { recordMovement } from "./ledger";
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

    const submitted = await svc.submitPo(ctx, po.id);
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

/*
 * T-A5 AC-C3 (wave A1 grant 2026-09-30 02:05): `reorderSuggestions` redistributes a style x
 * color group's suggested qty across sizes proportional to the trailing size curve
 * (`splitBySizeCurve` in `reorder.ts`), and creating a PO from a suggestion only ever produces
 * a still-editable draft that nothing submits automatically. Its own company keeps this test's
 * consumption movements and free-freight math isolated from the fixtures above.
 */
describe("reorder size-curve split (AC-C3)", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let sizeIds: Record<string, string>;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    const location = await createLocation(companyId);
    const rows = await withSystem((tx) =>
      tx
        .insert(blankVariants)
        .values(
          ["S", "M", "L"].map((size) => ({
            companyId,
            brand: "Gildan",
            style: "Softstyle",
            styleCode: "G70000",
            color: "Navy",
            colorCode: "NVY",
            size,
            sizeCode: size,
            sku: `G70000-NVY-${size}`,
            // T5C0<size>: picked so the mock supplier's stable per-SKU hash never lands on its
            // "1 in 12 SKUs is out of stock" bucket for any of these three (that would drop a
            // size out of the suggestion entirely before the curve split ever runs).
            supplierSku: `T5C0${size}`,
            costCents: 400,
          })),
        )
        .returning(),
    );
    sizeIds = Object.fromEntries(rows.map((r) => [r.size, r.id]));
    await withTenant(companyId, (tx) =>
      svc.updateSettings(tx, ctx, {
        suppliers: [
          { supplier: "ssactivewear", freeFreightThreshold: 0, accountNumber: null, apiKey: null },
        ],
      }),
    );
    // Trailing curve: S and M barely sell, L sells most (10% / 10% / 80% of the group's units).
    const consumed: Record<string, number> = { S: 3, M: 3, L: 24 };
    await withTenant(companyId, async (tx) => {
      for (const [size, id] of Object.entries(sizeIds)) {
        const n = consumed[size] as number;
        await recordMovement(tx, ctx, {
          blankVariantId: id,
          locationId: location.id,
          kind: "receive",
          qty: n,
        });
        await recordMovement(tx, ctx, {
          blankVariantId: id,
          locationId: location.id,
          kind: "consume",
          qty: -n,
        });
      }
    });
  });

  function sizeLines(sugg: Awaited<ReturnType<typeof svc.reorderSuggestions>>) {
    return (
      sugg.items
        .find((s) => s.supplier === "ssactivewear")
        ?.lines.filter((l) => l.blank.styleCode === "G70000") ?? []
    );
  }

  it("splits the group's suggested qty proportional to the trailing size curve, summing to the total", async () => {
    const sugg = await withTenant(companyId, (tx) => svc.reorderSuggestions(tx, ctx, {}));
    const lines = sizeLines(sugg);
    const bySize = new Map(lines.map((l) => [l.blank.size, l.suggestedQty]));
    // 22 units total (S/M each need 3, L needs 16 independently), redistributed 10/10/80%.
    expect(bySize.get("S")).toBe(2);
    expect(bySize.get("M")).toBe(2);
    expect(bySize.get("L")).toBe(18);
    const total = [...bySize.values()].reduce((sum, n) => sum + n, 0);
    expect(total).toBe(22);
    // L now carries a share close to its 80% sales share, not just whatever its own
    // independently-computed reorder point produced (16/22 = 72.7%).
    expect((bySize.get("L") as number) / total).toBeCloseTo(18 / 22, 5);
  });

  it("creates an editable draft PO from the suggestion, and nothing submits it automatically", async () => {
    const sugg = await withTenant(companyId, (tx) => svc.reorderSuggestions(tx, ctx, {}));
    const lines = sizeLines(sugg);
    expect(lines.length).toBe(3);

    const po = await withTenant(companyId, (tx) =>
      svc.createPoFromSuggestion(tx, ctx, {
        supplier: "ssactivewear",
        lines: lines.map((l) => ({ blankVariantId: l.blankVariantId, qty: l.suggestedQty })),
      }),
    );
    expect(po.status).toBe("draft");
    expect(po.lines.map((l) => l.qty).sort((a, b) => a - b)).toEqual([2, 2, 18]);

    // Every line is still editable on the draft before it is submitted.
    const edited = await withTenant(companyId, (tx) =>
      svc.updatePo(tx, ctx, {
        id: po.id,
        lines: po.lines.map((l) => ({ blankVariantId: l.blankVariantId, qty: l.qty + 5 })),
      }),
    );
    expect(edited.status).toBe("draft");
    expect(edited.lines.map((l) => l.qty).sort((a, b) => a - b)).toEqual([7, 7, 23]);

    // Re-reading it still shows draft: nothing submitted it behind the scenes.
    const reread = await withTenant(companyId, (tx) => svc.getPo(tx, ctx, po.id));
    expect(reread.status).toBe("draft");

    // Only an explicit submit call moves it off draft.
    const submitted = await svc.submitPo(ctx, po.id);
    expect(submitted.status).toBe("submitted");
  });
});
