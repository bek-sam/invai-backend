import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "../../db/client";
import { channelConnections, orderItems, orders } from "../../db/schema";
import { createCompany, createConnection, createOrder } from "../../test/fixtures";
import {
  createNameTemplate,
  exists,
  readBack,
  type SeededArt,
  seedItemArt,
  seedNotes,
} from "./buyer-text.fixtures";
import { buyerPiiCutoff, handlePrivacyRequest, redactStaleBuyerPii } from "./service";

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
