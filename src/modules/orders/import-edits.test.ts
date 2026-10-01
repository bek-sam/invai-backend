import type { NormalizedOrder } from "@invai/contracts";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../../api/context";
import { withTenant } from "../../db/client";
import { blankVariants, type channelConnections, orderItems, orders } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createLocation,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { bulkImportBlanks, createDesign } from "../catalog/service";
import { getConnectionRow } from "../channels/service";
import { createRule } from "../channels/sku";
import { importNormalizedOrders } from "./import";
import { cancelOrder, releaseOrder } from "./service";

/*
 * T-7-4 (B-12, B-26): staleness, the ship_by re-import fix, per-line cancels, channel line
 * edits around pressed units, and channel holds.
 */

let companyId: string;
let ctx: TenantContext;
let conn: typeof channelConnections.$inferSelect;
let tiktok: typeof channelConnections.$inferSelect;
const designIds: Record<string, string> = {};

beforeAll(async () => {
  companyId = (await createCompany()).id;
  const owner = await createUser(companyId, "owner");
  ctx = tenantContext(companyId, owner.id, "owner");
  await createLocation(companyId);
  const shop = await createConnection(companyId, "shopify");
  const tt = await createConnection(companyId, "tiktok");
  await withTenant(companyId, async (tx) => {
    await createRule(tx, ctx, {
      name: "Standard",
      patternType: "template",
      pattern: "{design}-{style}-{color}-{size}",
      channel: null,
      connectionId: null,
      target: { kind: "resolve", defaults: {} },
      priority: 10,
      active: true,
    });
    await bulkImportBlanks(tx, ctx, {
      rows: ["S", "M", "L"].map((size) => ({
        brand: "Gildan",
        style: "64000",
        styleCode: "G64000",
        styleName: null,
        color: "Black",
        colorCode: "BLK",
        colorHex: null,
        size,
        sizeCode: size,
        supplier: "ssactivewear" as const,
        supplierSku: `BBLK${size}`,
        cost: 289,
        weightOz: 5.3,
      })),
    });
    for (const code of ["DB001", "DB019"]) {
      const d = await createDesign(tx, ctx, {
        code,
        name: code,
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: `${companyId}/design/${code}.png`,
            widthIn: 11,
            heightIn: 12,
          },
        ],
        personalizationTemplateId: null,
      });
      designIds[code] = d.id;
    }
    conn = await getConnectionRow(tx, shop.id);
    tiktok = await getConnectionRow(tx, tt.id);
  });
  expect(await withTenant(companyId, (tx) => tx.select().from(blankVariants))).toHaveLength(3);
});

let seq = 0;
function order(
  lines: { id: string; sku: string; qty: number; name?: string }[],
  extra: Partial<NormalizedOrder> = {},
): NormalizedOrder {
  return {
    channel: "shopify",
    channelOrderId: `T74-${seq}`,
    orderNo: `#T74-${seq}`,
    placedAt: "2026-11-24T17:00:00.000Z",
    shipBy: null,
    isRush: false,
    buyerName: "Ana Buyer",
    buyerEmail: null,
    shipTo: null,
    shippingMethod: "Standard",
    totals: { subtotal: 2500, shipping: 500, tax: 0, discount: 0, total: 3000 },
    buyerNote: null,
    items: lines.map((l) => ({
      channelLineId: l.id,
      channelSku: l.sku,
      channelListingId: null,
      title: "Tee",
      variantTitle: null,
      quantity: l.qty,
      unitPrice: 2500,
      personalization: l.name ? [{ question: "name", answer: l.name, fileUrl: null }] : [],
    })),
    sourceUpdatedAt: null,
    ...extra,
  };
}

const run = (
  list: NormalizedOrder[],
  source: "api" | "webhook" | "csv" = "webhook",
  c = conn,
  extra: Parameters<typeof importNormalizedOrders>[4] = { source },
) => withTenant(companyId, (tx) => importNormalizedOrders(tx, ctx, c, list, { ...extra, source }));

const unitsOf = (orderId: string) =>
  withTenant(companyId, (tx) =>
    tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.lineNo, orderItems.unitNo),
  );
const orderRow = async (orderId: string) =>
  (await withTenant(companyId, (tx) => tx.select().from(orders).where(eq(orders.id, orderId))))[0];
const setState = (ids: string[], state: "pressed" | "packed") =>
  withTenant(companyId, async (tx) => {
    for (const id of ids) await tx.update(orderItems).set({ state }).where(eq(orderItems.id, id));
  });

describe("ship-by on import (B-26)", () => {
  it("skips Thanksgiving and re-imports an unchanged date-only ship_by as skipped", async () => {
    seq++;
    // Placed Tue 11/24 2026, Shopify default 2 days: Wed, (Thu 11/26 Thanksgiving), Fri 11/27.
    const first = await run([order([{ id: "a", sku: "DB001-G64000-BLK-M", qty: 1 }])], "csv");
    const o = await orderRow(first.orderIds[0] as string);
    expect(o?.shipBy.toISOString()).toBe("2026-11-28T06:59:59.999Z");

    seq++;
    const withShipBy = order([{ id: "a", sku: "DB001-G64000-BLK-M", qty: 1 }], {
      shipBy: "2026-11-30T12:00:00.000Z", // CSV date-only
    });
    const a = await run([withShipBy], "csv");
    const id = a.orderIds[0] as string;
    const stored = (await orderRow(id))?.shipBy.toISOString();
    expect(stored).toBe("2026-12-01T06:59:59.999Z"); // end of 11/30 in Phoenix
    const again = await run([withShipBy], "csv");
    expect(again).toMatchObject({ updated: 0, skipped: 1 });
    expect((await orderRow(id))?.shipBy.toISOString()).toBe(stored);
    const moved = await run([{ ...withShipBy, shipBy: "2026-12-02T12:00:00.000Z" }], "csv");
    expect(moved.updated).toBe(1);
    expect((await orderRow(id))?.shipBy.toISOString()).toBe("2026-12-03T06:59:59.999Z");
  });
});

describe("staleness (B-12)", () => {
  it("ignores a payload older than the last one applied, even after a floor scan", async () => {
    seq++;
    const base = order([{ id: "a", sku: "DB001-G64000-BLK-M", qty: 1 }], {
      sourceUpdatedAt: "2026-11-24T18:00:00.000Z",
    });
    const first = await run([base]);
    const id = first.orderIds[0] as string;

    const older = await run([
      { ...base, buyerNote: "old", sourceUpdatedAt: "2026-11-24T17:30:00.000Z" },
    ]);
    expect(older).toMatchObject({ stale: 1, skipped: 1, updated: 0, staleOrderIds: [id] });
    expect((await orderRow(id))?.buyerNote).toBeNull();

    const newer = await run([
      { ...base, buyerNote: "gift wrap", sourceUpdatedAt: "2026-11-24T19:00:00.000Z" },
    ]);
    expect(newer).toMatchObject({ updated: 1, stale: 0 });
    expect((await orderRow(id))?.channelUpdatedAt?.toISOString()).toBe("2026-11-24T19:00:00.000Z");
    // A later floor action moves orders.updated_at past the channel's clock; a channel edit made
    // before that action but delivered after it still applies.
    await withTenant(companyId, (tx) =>
      tx
        .update(orders)
        .set({ tags: ["scanned"] })
        .where(eq(orders.id, id)),
    );
    const late = await run([
      { ...base, buyerNote: "gift wrap, no receipt", sourceUpdatedAt: "2026-11-24T19:30:00.000Z" },
    ]);
    expect(late.updated).toBe(1);
    expect((await orderRow(id))?.buyerNote).toBe("gift wrap, no receipt");
    // The 19:00 payload re-delivered now is stale.
    const replay = await run([
      { ...base, buyerNote: "gift wrap", sourceUpdatedAt: "2026-11-24T19:00:00.000Z" },
    ]);
    expect(replay.stale).toBe(1);
    // No channel timestamp: no staleness check (CSV).
    const csv = await run([{ ...base, buyerNote: null, sourceUpdatedAt: null }], "csv");
    expect(csv.updated).toBe(1);
  });
});

describe("per-line cancel and line edits (B-12)", () => {
  it("cancels only the removed units of a line, cheapest first", async () => {
    seq++;
    const n = order([
      { id: "a", sku: "DB001-G64000-BLK-M", qty: 3 },
      { id: "b", sku: "DB019-G64000-BLK-L", qty: 1 },
    ]);
    const id = (await run([n])).orderIds[0] as string;
    const before = await unitsOf(id);
    expect(before.map((u) => u.state)).toEqual(["ready", "ready", "ready", "ready"]);
    const res = await run([
      order([
        { id: "a", sku: "DB001-G64000-BLK-M", qty: 1 },
        { id: "b", sku: "DB019-G64000-BLK-L", qty: 1 },
      ]),
    ]);
    expect(res.updated).toBe(1);
    const after = await unitsOf(id);
    expect(after.map((u) => [u.lineNo, u.unitNo, u.state, u.unitsInLine])).toEqual([
      [1, 1, "ready", 1],
      [1, 2, "cancelled", 1],
      [1, 3, "cancelled", 1],
      [2, 1, "ready", 1],
    ]);
    const o = await orderRow(id);
    expect(o?.status).not.toBe("cancelled");
    expect(o?.cancelReason).toBeNull();
    expect(o?.itemCount).toBe(2);
    // Idempotent: the same payload again changes nothing.
    expect(
      await run([
        order([
          { id: "a", sku: "DB001-G64000-BLK-M", qty: 1 },
          { id: "b", sku: "DB019-G64000-BLK-L", qty: 1 },
        ]),
      ]),
    ).toMatchObject({ updated: 0, skipped: 1 });
  });

  it("never touches pressed units: a removed line flags them once", async () => {
    seq++;
    const lines = [
      { id: "a", sku: "DB001-G64000-BLK-M", qty: 3 },
      { id: "b", sku: "DB019-G64000-BLK-L", qty: 1 },
    ];
    const id = (await run([order(lines)])).orderIds[0] as string;
    const u = await unitsOf(id);
    await setState([u[0]?.id as string, u[1]?.id as string], "pressed");
    const without = order([{ id: "b", sku: "DB019-G64000-BLK-L", qty: 1 }]);
    await run([without]);
    const after = await unitsOf(id);
    expect(after.map((x) => x.state)).toEqual(["pressed", "pressed", "cancelled", "ready"]);
    for (const p of after.slice(0, 2))
      expect(p.flags.map((f) => f.code)).toContain("channel_edit_after_press");
    // Clearing the flag and re-reading doesn't raise it again, nor count as an update.
    await withTenant(companyId, (tx) =>
      tx.update(orderItems).set({ flags: [] }).where(eq(orderItems.orderId, id)),
    );
    expect(await run([without])).toMatchObject({ updated: 0, skipped: 1 });
    expect((await unitsOf(id)).every((x) => x.flags.length === 0)).toBe(true);
  });

  it("a CSV missing a line cancels nothing (a bad row can drop it)", async () => {
    seq++;
    const id = (
      await run(
        [
          order([
            { id: "a", sku: "DB001-G64000-BLK-M", qty: 1 },
            { id: "b", sku: "DB019-G64000-BLK-L", qty: 1 },
          ]),
        ],
        "csv",
      )
    ).orderIds[0] as string;
    await run([order([{ id: "b", sku: "DB019-G64000-BLK-L", qty: 1 }])], "csv");
    expect((await unitsOf(id)).map((u) => u.state)).toEqual(["ready", "ready"]);
  });

  it("replaces a routed unit on a SKU edit, changes an unrouted one in place, flags a pressed one", async () => {
    seq++;
    const id = (
      await run([
        order([
          { id: "a", sku: "DB001-G64000-BLK-M", qty: 2 },
          { id: "b", sku: "NOPE-1", qty: 1 },
        ]),
      ])
    ).orderIds[0] as string;
    let u = await unitsOf(id);
    expect(u.map((x) => x.state)).toEqual(["ready", "ready", "needs_mapping"]);
    await setState([u[0]?.id as string], "pressed");
    await run([
      order([
        { id: "a", sku: "DB019-G64000-BLK-M", qty: 2 },
        { id: "b", sku: "DB001-G64000-BLK-S", qty: 1 },
      ]),
    ]);
    u = await unitsOf(id);
    const line1 = u.filter((x) => x.lineNo === 1);
    // Unit 1 was pressed: flagged, untouched. Unit 2 was cancelled and replaced by unit 3.
    expect(line1.map((x) => [x.unitNo, x.state, x.channelSku])).toEqual([
      [1, "pressed", "DB001-G64000-BLK-M"],
      [2, "cancelled", "DB001-G64000-BLK-M"],
      [3, "ready", "DB019-G64000-BLK-M"],
    ]);
    expect(line1[0]?.flags.map((f) => f.code)).toContain("channel_edit_after_press");
    expect(line1[2]?.designId).toBe(designIds.DB019);
    // The unmapped unit took the new SKU in place and mapped.
    const line2 = u.filter((x) => x.lineNo === 2);
    expect(line2.map((x) => [x.unitNo, x.state, x.designId])).toEqual([
      [1, "ready", designIds.DB001],
    ]);
    expect((await orderRow(id))?.cancelReason).toBeNull();
  });

  it("adds units for a quantity increase and a new line; a personalization edit replaces the unit", async () => {
    seq++;
    const id = (await run([order([{ id: "a", sku: "DB001-G64000-BLK-M", qty: 1, name: "ANA" }])]))
      .orderIds[0] as string;
    await run([
      order([
        { id: "a", sku: "DB001-G64000-BLK-M", qty: 2, name: "ANA" },
        { id: "c", sku: "DB019-G64000-BLK-S", qty: 1 },
      ]),
    ]);
    let u = await unitsOf(id);
    expect(u.map((x) => [x.lineNo, x.unitNo, x.state])).toEqual([
      [1, 1, "ready"],
      [1, 2, "ready"],
      [2, 1, "ready"],
    ]);
    expect((await orderRow(id))?.itemCount).toBe(3);
    await run([
      order([
        { id: "a", sku: "DB001-G64000-BLK-M", qty: 2, name: "ANNA" },
        { id: "c", sku: "DB019-G64000-BLK-S", qty: 1 },
      ]),
    ]);
    u = await unitsOf(id);
    const live = u.filter((x) => x.lineNo === 1 && x.state !== "cancelled");
    expect(live).toHaveLength(2);
    expect(live.every((x) => x.personalization[0]?.answer === "ANNA")).toBe(true);
    expect(u.filter((x) => x.state === "cancelled")).toHaveLength(2);
  });

  it("counts units the shop cancelled itself toward the channel's quantity", async () => {
    seq++;
    const lines = [{ id: "a", sku: "DB001-G64000-BLK-M", qty: 2 }];
    const id = (await run([order(lines)])).orderIds[0] as string;
    const u = await unitsOf(id);
    await withTenant(companyId, (tx) =>
      cancelOrder(tx, ctx, {
        id,
        reason: "out_of_stock",
        note: null,
        orderItemIds: [u[1]?.id as string],
      }),
    );
    // Same quantity: nothing re-added.
    expect(await run([order(lines)])).toMatchObject({ updated: 0 });
    // The channel removes that unit too: the shop's cancel already covers it.
    await run([order([{ id: "a", sku: "DB001-G64000-BLK-M", qty: 1 }])]);
    expect((await unitsOf(id)).map((x) => x.state)).toEqual(["ready", "cancelled"]);
  });
});

describe("channel line cancels (Walmart CSV)", () => {
  it("cancels only the listed line's units and flags pressed ones", async () => {
    seq++;
    const n = order([
      { id: "a", sku: "DB001-G64000-BLK-M", qty: 2 },
      { id: "b", sku: "DB019-G64000-BLK-L", qty: 1 },
    ]);
    const id = (await run([n], "csv")).orderIds[0] as string;
    const u = await unitsOf(id);
    await setState([u[0]?.id as string], "pressed");
    const cancel = { channelOrderId: n.channelOrderId, channelLineId: "a" };
    const res = await run([], "csv", conn, { source: "csv", cancelledLines: [cancel] });
    expect(res.cancelled).toBe(1);
    const after = await unitsOf(id);
    expect(after.map((x) => x.state)).toEqual(["pressed", "cancelled", "ready"]);
    expect(after[0]?.flags.map((f) => f.code)).toContain("channel_edit_after_press");
    expect((await orderRow(id))?.cancelReason).toBeNull();
    // Idempotent.
    expect(
      (await run([], "csv", conn, { source: "csv", cancelledLines: [cancel] })).cancelled,
    ).toBe(0);
  });
});

describe("channel holds (B-12)", () => {
  it("holds on a buyer cancel request once; a released hold stays released", async () => {
    seq++;
    const n = order([{ id: "a", sku: "DB001-G64000-BLK-M", qty: 1 }]);
    const id = (await run([n])).orderIds[0] as string;
    const hold = { channelOrderId: n.channelOrderId, signal: "buyer_cancel_request" as const };
    const res = await run([], "webhook", conn, { source: "webhook", holds: [hold] });
    expect(res.held).toBe(1);
    const o = await orderRow(id);
    expect(o?.holdReason).toBe("buyer_request");
    expect((await unitsOf(id))[0]?.state).toBe("on_hold");
    await withTenant(companyId, (tx) => releaseOrder(tx, ctx, id));
    const again = await run([], "webhook", conn, { source: "webhook", holds: [hold] });
    expect(again.held).toBe(0);
    expect((await unitsOf(id))[0]?.state).toBe("ready");
  });

  it("maps TikTok ON_HOLD to a hold", async () => {
    seq++;
    const n = {
      ...order([{ id: "a", sku: "DB001-G64000-BLK-M", qty: 1 }]),
      channel: "tiktok" as const,
    };
    const id = (await run([n], "csv", tiktok)).orderIds[0] as string;
    const res = await run([], "csv", tiktok, {
      source: "csv",
      holds: [{ channelOrderId: n.channelOrderId, signal: "channel_on_hold" }],
    });
    expect(res.held).toBe(1);
    const [o] = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, id), eq(orders.holdReason, "other"))),
    );
    expect(o?.holdNote).toMatch(/TikTok/);
  });
});

describe("re-import after a reprint (B-242, decision 0020)", () => {
  // What `openReprint` does to a unit: the same row is flagged re-pressed, back to "ready".
  const reprint = (id: string) =>
    withTenant(companyId, (tx) =>
      tx
        .update(orderItems)
        .set({ isReprint: true, state: "ready", transferId: null, gangSheetId: null })
        .where(eq(orderItems.id, id)),
    );

  it("a quantity-1 line whose unit was reprinted gets no second unit", async () => {
    seq++;
    const lines = [
      { id: "a", sku: "DB001-G64000-BLK-M", qty: 1 },
      { id: "b", sku: "DB019-G64000-BLK-L", qty: 1 },
    ];
    const id = (await run([order(lines)])).orderIds[0] as string;
    const before = await unitsOf(id);
    await reprint(before[0]?.id as string);
    expect(await run([order(lines)])).toMatchObject({ updated: 0, skipped: 1 });
    const after = await unitsOf(id);
    expect(after.map((u) => [u.id, u.lineNo, u.unitNo, u.state, u.isReprint])).toEqual([
      [before[0]?.id, 1, 1, "ready", true],
      [before[1]?.id, 2, 1, "ready", false],
    ]);
    expect((await orderRow(id))?.itemCount).toBe(2);
  });

  it("a quantity-2 line with one unit reprinted keeps two units", async () => {
    seq++;
    const lines = [{ id: "a", sku: "DB001-G64000-BLK-M", qty: 2 }];
    const id = (await run([order(lines)])).orderIds[0] as string;
    const before = await unitsOf(id);
    await reprint(before[1]?.id as string);
    expect(await run([order(lines)])).toMatchObject({ updated: 0, skipped: 1 });
    const after = await unitsOf(id);
    expect(after.map((u) => [u.id, u.unitNo, u.state, u.isReprint])).toEqual([
      [before[0]?.id, 1, "ready", false],
      [before[1]?.id, 2, "ready", true],
    ]);
    // A real quantity drop to 1 still counts the reprinted unit (one unit is cancelled, not none).
    await run([order([{ id: "a", sku: "DB001-G64000-BLK-M", qty: 1 }])]);
    expect((await unitsOf(id)).filter((u) => u.state !== "cancelled")).toHaveLength(1);
  });

  it("a channel line-cancel cancels the reprinted unit too", async () => {
    seq++;
    const n = order([
      { id: "a", sku: "DB001-G64000-BLK-M", qty: 2 },
      { id: "b", sku: "DB019-G64000-BLK-L", qty: 1 },
    ]);
    const id = (await run([n], "csv")).orderIds[0] as string;
    const u = await unitsOf(id);
    await reprint(u[0]?.id as string);
    const cancel = { channelOrderId: n.channelOrderId, channelLineId: "a" };
    const res = await run([], "csv", conn, { source: "csv", cancelledLines: [cancel] });
    expect(res.cancelled).toBe(1);
    const after = await unitsOf(id);
    expect(after.map((x) => [x.state, x.isReprint])).toEqual([
      ["cancelled", true],
      ["cancelled", false],
      ["ready", false],
    ]);
    expect(
      (await run([], "csv", conn, { source: "csv", cancelledLines: [cancel] })).cancelled,
    ).toBe(0);
  });
});
