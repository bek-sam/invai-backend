import { randomUUID } from "node:crypto";
import { canTransition, type OrderItemState } from "@invai/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { PRINT_SIZES, rng } from "../data";
import { buildCatalog, fileKeys } from "./catalog";
import { type GenContext, generateDay } from "./generate";
import { SCALE_PROFILES, type ScaleProfile, staffCount } from "./profiles";

/*
 * T-54-3 acceptance, pure layer: the rows a profile would write, generated day by day without a
 * database, checked against the spec's fixture minimums (AC4, AC5, AC11) for all three profiles.
 */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const SIZE_SET = new Set(Object.values(PRINT_SIZES).map((s) => `${s.widthIn}x${s.heightIn}`));
const CHANNELS = ["etsy", "shopify", "amazon", "tiktok", "walmart"] as const;

type Stats = ReturnType<typeof newStats>;
function newStats() {
  return {
    orders: 0,
    items: 0,
    transitions: 0,
    badTransitions: 0,
    brokenChains: 0,
    multiUnitRows: 0,
    nonIntegerMoney: 0,
    shippedPerChannel: Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<string, number>,
    shipped: 0,
    late: 0,
    openPastShipBy: 0,
    pressedItems: 0,
    sheets: 0,
    sheetUtilSum: 0,
    sheetsWithoutCost: 0,
    badSizes: 0,
    reprintReasons: new Set<string>(),
    reprintRows: 0,
    shippedItems: 0,
    profitLines: 0,
    profitEstimated: 0,
    cancelledAfterOnSheet: 0,
    onHold: 0,
    needsMapping: 0,
    needsArtwork: 0,
    reprintItems: 0,
    fileKeys: new Set<string>(),
    unlinkedSheeted: 0,
  };
}

function runProfile(profile: ScaleProfile): Stats {
  const companyId = randomUUID();
  const random = rng(7);
  const catalog = buildCatalog(companyId, profile, random);
  const keys = fileKeys(companyId);
  const ctx: GenContext = {
    profile,
    now: NOW,
    random,
    companyId,
    connections: Object.fromEntries(
      CHANNELS.map((c) => [c, randomUUID()]),
    ) as GenContext["connections"],
    vendorConnectionIds: Array.from({ length: profile.vendors }, () => randomUUID()),
    pressStationIds: [randomUUID()],
    skus: catalog.skus,
    sheetKeys: { png: keys.sheet, preview: keys.sheetPreview },
    counters: { order: 0, sheet: 0, reprint: 0 },
  };
  const s = newStats();
  for (const d of catalog.designFileRows) {
    s.fileKeys.add(d.fileKey as string);
    if (d.previewKey) s.fileKeys.add(d.previewKey);
    if (!SIZE_SET.has(`${d.widthIn}x${d.heightIn}`)) s.badSizes++;
  }
  for (let d = profile.historyDays - 1; d >= 0; d--) {
    const day = generateDay(ctx, d);
    s.orders += day.orders.length;
    s.items += day.items.length;
    const lineRows = new Map<string, { rows: number; units: number }>();
    const itemById = new Map(day.items.map((i) => [i.id as string, i]));
    for (const it of day.items) {
      const k = `${it.orderId}:${it.lineNo}`;
      const e = lineRows.get(k) ?? { rows: 0, units: it.unitsInLine as number };
      e.rows++;
      lineRows.set(k, e);
      if (it.gangSheetId && !it.transferId) s.unlinkedSheeted++;
      if (it.isReprint) s.reprintItems++;
      for (const f of [it.unitPriceCents]) if (!Number.isInteger(f)) s.nonIntegerMoney++;
    }
    for (const e of lineRows.values()) if (e.rows !== e.units) s.multiUnitRows++;
    for (const o of day.orders) {
      for (const f of [
        o.subtotalCents,
        o.shippingCents,
        o.taxCents,
        o.totalCents,
        o.discountCents,
      ]) {
        if (!Number.isInteger(f)) s.nonIntegerMoney++;
      }
      if (o.shippedAt) {
        s.shipped++;
        s.shippedPerChannel[o.channel as string] =
          (s.shippedPerChannel[o.channel as string] ?? 0) + 1;
        if ((o.shippedAt as Date) > (o.shipBy as Date)) s.late++;
      }
      if (
        !o.shippedAt &&
        !["cancelled", "shipped", "delivered"].includes(o.status as string) &&
        (o.shipBy as Date).getTime() < NOW
      ) {
        s.openPastShipBy++;
      }
    }
    const byItem = new Map<string, typeof day.transitions>();
    for (const t of day.transitions) {
      s.transitions++;
      const list = byItem.get(t.orderItemId as string) ?? [];
      list.push(t);
      byItem.set(t.orderItemId as string, list);
      if (!canTransition(t.fromState as OrderItemState, t.toState as OrderItemState)) {
        s.badTransitions++;
      }
    }
    for (const [itemId, list] of byItem) {
      let prev = "imported";
      for (const t of list) {
        if (t.fromState !== prev) s.brokenChains++;
        prev = t.toState as string;
      }
      if (itemById.get(itemId)?.state !== prev) s.brokenChains++;
      const to = list.map((t) => t.toState);
      if (to.includes("pressed")) s.pressedItems++;
      const onSheetAt = to.indexOf("on_sheet");
      if (onSheetAt >= 0 && to.at(-1) === "cancelled") s.cancelledAfterOnSheet++;
    }
    for (const it of day.items) {
      if (it.state === "on_hold") s.onHold++;
      if (it.state === "needs_mapping") s.needsMapping++;
      if (it.state === "needs_artwork") s.needsArtwork++;
      if (it.state === "shipped" || it.state === "delivered") s.shippedItems++;
    }
    for (const sh of day.sheets) {
      s.sheets++;
      s.sheetUtilSum += sh.utilization as number;
      if (!((sh.costCents as number) > 0)) s.sheetsWithoutCost++;
      for (const k of [sh.pngKey, sh.previewKey, sh.pdfKey]) if (k) s.fileKeys.add(k);
    }
    for (const t of day.transfers) {
      if (!SIZE_SET.has(`${t.widthIn}x${t.heightIn}`)) s.badSizes++;
    }
    for (const r of day.reprints) {
      s.reprintRows++;
      if (r.status !== "cancelled") s.reprintReasons.add(r.reason as string);
    }
    for (const p of day.profit) {
      s.profitLines++;
      if ((p.estimated as string[]).length > 0) s.profitEstimated++;
      for (const f of [
        p.revenueCents,
        p.channelFeesCents,
        p.blankCostCents,
        p.transferCostCents,
        p.labelCostCents,
        p.packagingCostCents,
        p.laborCostCents,
        p.adsCostCents,
        p.refundsCents,
        p.netCents,
      ]) {
        if (!Number.isInteger(f)) s.nonIntegerMoney++;
      }
    }
  }
  return s;
}

describe.each(["small", "mid", "large"] as const)("%s profile rows (in memory)", (name) => {
  const profile = SCALE_PROFILES[name];
  let s: Stats;
  beforeAll(() => {
    s = runProfile(profile);
  }, 300_000);

  it("AC2: orders per day and items per order are within 20% of the table", () => {
    expect(s.orders / profile.historyDays).toBeGreaterThan(profile.ordersPerDay * 0.8);
    expect(s.orders / profile.historyDays).toBeLessThan(profile.ordersPerDay * 1.2);
    expect(s.items / s.orders).toBeGreaterThan(profile.meanItems * 0.8);
    expect(s.items / s.orders).toBeLessThan(profile.meanItems * 1.2);
    expect(staffCount(profile)).toBe(name === "small" ? 3 : name === "mid" ? 8 : 30);
  });

  it("AC5a: one row is one unit; AC5b: every money value is an integer", () => {
    expect(s.multiUnitRows).toBe(0);
    expect(s.nonIntegerMoney).toBe(0);
  });

  it("AC5c/AC4: every transfer and design size is in the data.ts print-size table", () => {
    expect(s.badSizes).toBe(0);
    expect(PRINT_SIZES.left_chest.widthIn).toBe(3.75);
  });

  it("every transition passes canTransition and chains from imported to the item's state", () => {
    expect(s.transitions).toBeGreaterThan(s.items);
    expect(s.badTransitions).toBe(0);
    expect(s.brokenChains).toBe(0);
  });

  it("AC4: enough sent sheets, all with a cost, average utilization 0.80-0.95", () => {
    expect(s.sheets).toBeGreaterThanOrEqual(profile.floors.sentSheets);
    expect(s.sheetsWithoutCost).toBe(0);
    const avg = s.sheetUtilSum / s.sheets;
    expect(avg).toBeGreaterThanOrEqual(0.8);
    expect(avg).toBeLessThanOrEqual(0.95);
    expect(s.unlinkedSheeted).toBe(0);
  });

  it("AC7: at most 50 distinct file keys across design, sheet and artwork columns", () => {
    expect(s.fileKeys.size).toBeLessThanOrEqual(50);
  });

  it("AC11 fixture minimums: shipped per channel, late 3-8%, open past ship-by, pressed items", () => {
    const channelsOver = CHANNELS.filter(
      (c) => (s.shippedPerChannel[c] ?? 0) >= profile.floors.shippedPerChannel,
    );
    expect(channelsOver.length).toBeGreaterThanOrEqual(3);
    expect(s.late / s.shipped).toBeGreaterThanOrEqual(0.03);
    expect(s.late / s.shipped).toBeLessThanOrEqual(0.08);
    expect(s.openPastShipBy).toBeGreaterThanOrEqual(profile.floors.openPastShipBy);
    expect(s.pressedItems).toBeGreaterThanOrEqual(profile.floors.pressedItems);
    expect(s.reprintReasons.size).toBeGreaterThanOrEqual(2);
  });

  it("AC11 profit lines: one per shipped item, at least 10% estimated", () => {
    expect(s.profitLines).toBe(s.shippedItems);
    expect(s.profitEstimated / s.profitLines).toBeGreaterThanOrEqual(0.1);
  });

  it("AC11 edge states: cancelled after on_sheet, on hold, needs_mapping, needs_artwork, reprint", () => {
    expect(s.cancelledAfterOnSheet).toBeGreaterThanOrEqual(1);
    expect(s.onHold).toBeGreaterThanOrEqual(1);
    expect(s.needsMapping).toBeGreaterThanOrEqual(1);
    expect(s.needsArtwork).toBeGreaterThanOrEqual(1);
    expect(s.reprintItems).toBeGreaterThanOrEqual(1);
    expect(s.reprintRows).toBeGreaterThanOrEqual(1);
  });
});

describe("determinism", () => {
  it("the same now and profile give the same row counts", () => {
    const a = runProfile(SCALE_PROFILES.small);
    const b = runProfile(SCALE_PROFILES.small);
    expect([a.orders, a.items, a.transitions, a.sheets]).toEqual([
      b.orders,
      b.items,
      b.transitions,
      b.sheets,
    ]);
  });
});
