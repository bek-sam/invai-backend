import { ITEM_FLAG_CODES } from "@invai/contracts";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { channelConnections, orderItems, orderNotes, orders } from "../../db/schema";
import { getObject } from "../../lib/s3";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { setItemFlag } from "../orders/service";
import {
  createNameTemplate,
  exists,
  readBack,
  type SeededArt,
  seedItemArt,
  seedNotes,
} from "./buyer-text.fixtures";
import {
  buyerPiiCutoff,
  exportKey,
  handlePrivacyRequest,
  redactBuyerText,
  redactStaleBuyerPii,
  requestExport,
  runTenantExport,
} from "./service";
import { readZip } from "./zip";

/*
 * T-29-1 (S-56, B-293, B-296, decision 0027): redact requests and the 18-month sweep clear every
 * unit's personalization text, rendered art (objects too) and free-text notes, whatever the
 * unit's state. Storage first: a failed delete keeps the unit for a retry.
 */

const s3 = vi.hoisted(() => ({ failing: new Set<string>() }));
vi.mock("../../lib/s3", async (orig) => {
  const actual = await orig<typeof import("../../lib/s3")>();
  return {
    ...actual,
    deleteObject: async (key: string) => {
      if (s3.failing.has(key)) throw new Error("storage unavailable");
      return actual.deleteObject(key);
    },
  };
});

/** A row snapshot without `updated_at` (a redelivery re-touches the order row, changing nothing). */
const facts = (r: unknown) => JSON.stringify(r, (k, v) => (k === "updatedAt" ? undefined : v));

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let companyId: string;
let templateId: string;
let shop: string;
let shopifyConn: string;

beforeAll(async () => {
  companyId = (await createCompany()).id;
  templateId = (await createNameTemplate(companyId)).id;
  shop = `t291-${uniq()}.myshopify.com`;
  shopifyConn = (await createConnection(companyId, "shopify")).id;
  await withSystem((tx) =>
    tx
      .update(channelConnections)
      .set({ externalShopId: shop, status: "connected" })
      .where(eq(channelConnections.id, shopifyConn)),
  );
});

/** A two-unit personalized order: one unit delivered, one still being made. */
async function order(set: Partial<typeof orders.$inferInsert> = { status: "partially_shipped" }) {
  const { order, items } = await createOrder(companyId, shopifyConn, {
    units: 2,
    channel: "shopify",
  });
  const [a, b] = items;
  if (!a || !b) throw new Error("items");
  await withSystem(async (tx) => {
    await tx.update(orders).set(set).where(eq(orders.id, order.id));
    await tx.update(orderItems).set({ state: "delivered" }).where(eq(orderItems.id, a.id));
    await tx.update(orderItems).set({ state: "ready" }).where(eq(orderItems.id, b.id));
  });
  const artA = await seedItemArt(companyId, a.id, templateId);
  const artB = await seedItemArt(companyId, b.id, templateId);
  await seedNotes(companyId, order.id, a.id, "Probe note");
  return { order, a: a.id, b: b.id, arts: [artA, artB] as SeededArt[] };
}

async function expectAllCleared(o: Awaited<ReturnType<typeof order>>) {
  for (const [i, itemId] of [o.a, o.b].entries()) {
    const r = await readBack(companyId, o.order.id, itemId);
    expect(r.item?.personalization).toEqual([{ question: "name", answer: null, fileUrl: null }]);
    expect(r.item).toMatchObject({ artworkKey: null, artworkPreviewKey: null });
    expect(r.item?.artworkStatus).toBe("purged");
    expect(r.item?.flags.map((f) => f.code)).toEqual(["address_check"]);
    expect(r.art).toMatchObject({ values: {}, flags: [], error: null, status: "purged" });
    expect(r.art?.fileKey ?? r.art?.previewKey ?? null).toBeNull();
    expect(r.order).toMatchObject({ buyerNote: null, holdNote: null, cancelNote: null });
    expect(r.refunds.every((x) => x.note === null)).toBe(true);
    expect(r.reprints.every((x) => x.note === null)).toBe(true);
    const art = o.arts[i] as SeededArt;
    for (const k of [art.fileKey, art.previewKey, art.photoKey])
      expect(await exists(k)).toBe(false);
  }
}

const redact = (channelOrderIds: string[]) =>
  handlePrivacyRequest({
    channel: "shopify",
    shopDomain: shop,
    deliveryId: `t291-${uniq()}`,
    request: {
      topic: "customers/redact",
      channelCustomerId: "c-1",
      channelRequestId: "r-1",
      channelOrderIds,
    },
  });

describe("redact requests clear every unit", () => {
  it("customers/redact clears text, art and notes of units in any state, and a redelivery changes nothing", async () => {
    const o = await order();
    const res = await redact([o.order.channelOrderId]);
    expect(res.handled).toBe(true);
    await expectAllCleared(o);
    const snap = facts(await readBack(companyId, o.order.id, o.b));
    await redact([o.order.channelOrderId]);
    expect(facts(await readBack(companyId, o.order.id, o.b))).toBe(snap);
  });

  it("a failed object delete rolls the redaction back, so the redelivery finishes it", async () => {
    const o = await order();
    s3.failing.add((o.arts[1] as SeededArt).fileKey);
    try {
      await expect(redact([o.order.channelOrderId])).rejects.toThrow(/object delete failed/);
    } finally {
      s3.failing.clear();
    }
    const kept = await readBack(companyId, o.order.id, o.b);
    expect(kept.art?.status).toBe("approved");
    expect(kept.order?.buyerNote).toBe("Probe note");
    await redact([o.order.channelOrderId]);
    await expectAllCleared(o);
  });
});

describe("18-month sweep and staff notes (T-52-4, A7)", () => {
  const notesOf = (orderId: string) =>
    withTenant(companyId, (tx) =>
      tx.select().from(orderNotes).where(eq(orderNotes.orderId, orderId)),
    );

  it("sweeps an order whose only buyer text is an order_notes row, and keeps a recent one", async () => {
    const placedAt = new Date(buyerPiiCutoff().getTime() - 86400_000);
    const mk = async (set: Partial<typeof orders.$inferInsert>) => {
      const { order } = await createOrder(companyId, shopifyConn, { units: 1, channel: "shopify" });
      await withSystem(async (tx) => {
        await tx.update(orders).set(set).where(eq(orders.id, order.id));
        await tx
          .insert(orderNotes)
          .values({ companyId, orderId: order.id, kind: "hold", text: "Probe staff text" });
      });
      return order.id;
    };
    const old = await mk({ placedAt, shippedAt: placedAt, status: "shipped" });
    const recent = await mk({ status: "shipped" });
    await redactStaleBuyerPii();
    expect(await notesOf(old)).toEqual([]);
    expect(await notesOf(recent)).toHaveLength(1);
    await redactStaleBuyerPii();
    expect(await notesOf(old)).toEqual([]);
  });
});

describe("18-month sweep clears every unit", () => {
  const old = () => {
    const placedAt = new Date(buyerPiiCutoff().getTime() - 86400_000);
    return { placedAt, shippedAt: placedAt, status: "partially_shipped" as const };
  };

  it("clears units in any state and is idempotent", async () => {
    const o = await order(old());
    await redactStaleBuyerPii();
    await expectAllCleared(o);
    const snap = facts(await readBack(companyId, o.order.id, o.a));
    await redactStaleBuyerPii();
    expect(facts(await readBack(companyId, o.order.id, o.a))).toBe(snap);
  });

  it("passes over an order whose delete failed and finishes it the next day", async () => {
    const o = await order(old());
    s3.failing.add((o.arts[0] as SeededArt).photoKey);
    try {
      await redactStaleBuyerPii();
    } finally {
      s3.failing.clear();
    }
    expect((await readBack(companyId, o.order.id, o.a)).art?.status).toBe("approved");
    expect((await readBack(companyId, o.order.id, o.b)).art?.status).toBe("purged");
    await redactStaleBuyerPii();
    await expectAllCleared(o);
  });
});

/*
 * T-53-3 (B-459, decision 0027 amendment): a flag's staff `message` (setItemFlag note) is buyer
 * text. Purged with the order; code, severity, active and createdAt stay; the export still has it.
 */
describe("staff flag text is purged with the order", () => {
  let cid: string;
  let ctx: ReturnType<typeof tenantContext>;
  let conn: string;
  const marker = (code: string) => `Probe flag text ${code} ${uniq()}`;

  beforeAll(async () => {
    cid = (await createCompany()).id;
    const office = await createUser(cid, "office");
    ctx = tenantContext(cid, office.id, "office");
    conn = (await createConnection(cid)).id;
  });

  /** One unit carrying one flag per code, each with its own marker; the unit stays in `state`. */
  async function flagged(state: "ready" | "delivered", set: Partial<typeof orders.$inferInsert>) {
    const { order, items } = await createOrder(cid, conn, { units: 1 });
    const item = items[0];
    if (!item) throw new Error("item");
    await withSystem(async (tx) => {
      await tx.update(orders).set(set).where(eq(orders.id, order.id));
      await tx.update(orderItems).set({ state }).where(eq(orderItems.id, item.id));
    });
    const markers = new Map<string, string>();
    for (const code of ITEM_FLAG_CODES) {
      const m = marker(code);
      markers.set(code, m);
      await withTenant(cid, (tx) =>
        setItemFlag(tx, ctx, { id: item.id, code, active: true, note: m }),
      );
    }
    return { orderId: order.id, itemId: item.id, markers };
  }

  const itemRow = (itemId: string) =>
    withTenant(cid, async (tx) => {
      const [r] = await tx.select().from(orderItems).where(eq(orderItems.id, itemId));
      return r;
    });

  const shape = (flags: { code: string; severity: string; active: boolean; createdAt: string }[]) =>
    flags.map(({ code, severity, active, createdAt }) => ({ code, severity, active, createdAt }));

  it("resets every code's message on both clocks, keeping code, severity, active, createdAt", async () => {
    const old = new Date(buyerPiiCutoff().getTime() - 86400_000);
    const all = await flagged("ready", { placedAt: old, shippedAt: old, status: "shipped" });
    const shipped = await flagged("delivered", { status: "delivered" });
    const before = shape((await itemRow(shipped.itemId))?.flags ?? []);
    expect(before.map((f) => f.code).sort()).toEqual([...ITEM_FLAG_CODES].sort());

    // 30-day clock (scope shipped-items), order-level: even the unit still in production resets.
    await withTenant(cid, (tx) =>
      redactBuyerText(tx, [shipped.orderId], { scope: "shipped-items" }),
    );
    const r = await itemRow(shipped.itemId);
    for (const m of shipped.markers.values()) expect(JSON.stringify(r)).not.toContain(m);
    expect(shape(r?.flags ?? [])).toEqual(before);
    for (const f of r?.flags ?? []) expect(f.message).toBe(f.code.replace(/_/g, " "));

    // 18-month sweep (scope all).
    await redactStaleBuyerPii();
    const r2 = await itemRow(all.itemId);
    for (const m of all.markers.values()) expect(JSON.stringify(r2)).not.toContain(m);
    expect((r2?.flags ?? []).map((f) => f.message)).toEqual(
      (r2?.flags ?? []).map((f) => f.code.replace(/_/g, " ")),
    );

    // Run twice: nothing changes.
    const snap = facts(await itemRow(shipped.itemId));
    await withTenant(cid, (tx) =>
      redactBuyerText(tx, [shipped.orderId], { scope: "shipped-items" }),
    );
    expect(facts(await itemRow(shipped.itemId))).toBe(snap);
  });

  it("keeps artwork-code flags consistent: purge removes them, other flag text still resets", async () => {
    const o = await flagged("delivered", { status: "delivered" });
    await withSystem((tx) =>
      tx.update(orderItems).set({ artworkStatus: "approved" }).where(eq(orderItems.id, o.itemId)),
    );
    await withTenant(cid, (tx) => redactBuyerText(tx, [o.orderId], { scope: "all" }));
    const r = await itemRow(o.itemId);
    for (const m of o.markers.values()) expect(JSON.stringify(r)).not.toContain(m);
    expect(r?.flags.some((f) => f.code === "address_invalid")).toBe(true);
  });

  it("picks up a legacy already-purged order whose only buyer text is a flag message", async () => {
    const old = new Date(buyerPiiCutoff().getTime() - 86400_000);
    const o = await flagged("delivered", { placedAt: old, shippedAt: old, status: "shipped" });
    // Legacy: everything else was purged by the earlier version; only the flag text stayed.
    await withSystem((tx) => tx.delete(orderNotes).where(eq(orderNotes.orderId, o.orderId)));
    await redactStaleBuyerPii();
    const r = await itemRow(o.itemId);
    for (const m of o.markers.values()) expect(JSON.stringify(r)).not.toContain(m);
  });

  it("leaves an order alone that has no flag text (no rewrite)", async () => {
    const { order, items } = await createOrder(cid, conn, { units: 1 });
    const id = items[0]?.id as string;
    await withTenant(cid, (tx) =>
      setItemFlag(tx, ctx, { id, code: "reprint", active: true, note: null }),
    );
    const snap = facts(await itemRow(id));
    await withTenant(cid, (tx) => redactBuyerText(tx, [order.id], { scope: "all" }));
    expect(facts(await itemRow(id))).toBe(snap);
  });

  it("export carries the flag message before the purge, and not after", async () => {
    const o = await flagged("delivered", { status: "delivered" });
    const exportItems = async () => {
      const job = await withTenant(cid, (tx) => requestExport(tx, ctx));
      await runTenantExport(cid, job.id);
      const zip = readZip(await getObject(exportKey(cid, job.id)));
      return zip.get("tables/order_items.json")?.toString("utf8") ?? "";
    };
    const first = await exportItems();
    for (const m of o.markers.values()) expect(first).toContain(m);
    await withTenant(cid, (tx) => redactBuyerText(tx, [o.orderId], { scope: "all" }));
    const second = await exportItems();
    for (const m of o.markers.values()) expect(second).not.toContain(m);
  });
});
