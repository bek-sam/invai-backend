import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, files, orderItems, orders, reprints } from "../../db/schema";
import { headObject, objectKey, putObject } from "../../lib/s3";
import { createCompany, createConnection, createOrder } from "../../test/fixtures";
import {
  createNameTemplate,
  exists,
  readBack,
  type SeededArt,
  seedItemArt,
  seedNotes,
} from "../privacy/buyer-text.fixtures";
import { redactBuyerText } from "../privacy/service";
import { purgeBuyerPii, purgePiiObjects } from "./jobs";

/* Real MinIO, with a switch to make chosen keys fail to delete. */
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

type ItemState = (typeof orderItems.$inferInsert)["state"] & string;

const days = (n: number) => new Date(Date.now() - n * 86400_000);

describe("buyer PII retention", () => {
  it("purges orders that never get a delivery event 30 days after shipping or cancelling", async () => {
    const companyId = (await createCompany()).id;
    const conn = await createConnection(companyId);
    const cases = {
      shippedOld: { shippedAt: days(31) },
      cancelledOld: { cancelledAt: days(31) },
      deliveredOld: { shippedAt: days(40), deliveredAt: days(35) },
      shippedRecent: { shippedAt: days(5) },
      deliveredRecent: { shippedAt: days(40), deliveredAt: days(10) },
      open: {},
    };
    const ids: Record<string, string> = {};
    for (const [label, set] of Object.entries(cases)) {
      const { order } = await createOrder(companyId, conn.id);
      ids[label] = order.id;
      await withSystem(async (tx) => {
        if (Object.keys(set).length)
          await tx.update(orders).set(set).where(eq(orders.id, order.id));
        await tx.insert(buyerPii).values({ companyId, orderId: order.id, name: `Buyer ${label}` });
      });
    }
    await purgeBuyerPii();
    const left = await withTenant(companyId, (tx) =>
      tx
        .select({ orderId: buyerPii.orderId })
        .from(buyerPii)
        .where(inArray(buyerPii.orderId, Object.values(ids))),
    );
    const kept = new Set(left.map((r) => r.orderId));
    expect(
      Object.keys(ids)
        .filter((k) => kept.has(ids[k] as string))
        .sort(),
    ).toEqual(["deliveredRecent", "open", "shippedRecent"]);
  });

  it("deletes raw payloads, order CSVs and labels past retention, and their file rows", async () => {
    const companyId = (await createCompany()).id;
    const raw = await putObject(objectKey(companyId, "raw", "json"), "{}", "application/json");
    const csv = await putObject(objectKey(companyId, "csv", "csv"), "name\nJane", "text/csv");
    const label = await putObject(objectKey(companyId, "label", "pdf"), "%PDF", "application/pdf");
    const design = await putObject(objectKey(companyId, "design", "png"), "png", "image/png");
    await withTenant(companyId, (tx) =>
      tx.insert(files).values({ companyId, key: csv, kind: "csv", status: "ready" }),
    );
    // Nothing is old enough today.
    expect((await purgePiiObjects(new Date(), [companyId])).objects).toBe(0);
    // 31 days later every PII kind is gone; designs stay.
    const later = new Date(Date.now() + 31 * 86400_000);
    expect((await purgePiiObjects(later, [companyId])).objects).toBe(3);
    for (const key of [raw, csv, label]) expect((await headObject(key)).exists).toBe(false);
    expect((await headObject(design)).exists).toBe(true);
    const rows = await withTenant(companyId, (tx) =>
      tx.select().from(files).where(eq(files.key, csv)),
    );
    expect(rows).toHaveLength(0);
  });
});

/*
 * T-29-1 (S-56, B-293, B-296, decision 0027): the 30-day clock also clears personalization text,
 * rendered art and free-text notes, per unit: only units already shipped, delivered or cancelled.
 */
describe("buyer text on the 30-day clock", () => {
  let companyId: string;
  let connId: string;
  let templateId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    connId = (await createConnection(companyId)).id;
    templateId = (await createNameTemplate(companyId)).id;
  });

  /** A two-unit personalized order aged past (or inside) its clock. */
  async function personalizedOrder(
    set: Partial<typeof orders.$inferInsert>,
    states: [ItemState, ItemState],
    opts: { pii?: boolean } = {},
  ) {
    const { order, items } = await createOrder(companyId, connId, { units: 2 });
    const [a, b] = items;
    if (!a || !b) throw new Error("items");
    await withSystem(async (tx) => {
      await tx.update(orders).set(set).where(eq(orders.id, order.id));
      await tx.update(orderItems).set({ state: states[0] }).where(eq(orderItems.id, a.id));
      await tx.update(orderItems).set({ state: states[1] }).where(eq(orderItems.id, b.id));
      if (opts.pii !== false)
        await tx.insert(buyerPii).values({ companyId, orderId: order.id, name: "Probe Buyer" });
    });
    const artA = await seedItemArt(companyId, a.id, templateId);
    const artB = await seedItemArt(companyId, b.id, templateId);
    await seedNotes(companyId, order.id, a.id, "Probe note A");
    await withSystem((tx) =>
      tx.insert(reprints).values({ companyId, orderItemId: b.id, reason: "peel", note: "Probe B" }),
    );
    return { orderId: order.id, a: a.id, b: b.id, artA, artB };
  }

  function expectCleared(r: Awaited<ReturnType<typeof readBack>>) {
    expect(r.item?.personalization).toEqual([{ question: "name", answer: null, fileUrl: null }]);
    expect(r.item?.artworkKey).toBeNull();
    expect(r.item?.artworkPreviewKey).toBeNull();
    expect(r.item?.artworkStatus).toBe("purged");
    // Artwork flags quote the buyer's text and go; other flags stay.
    expect(r.item?.flags.map((f) => f.code)).toEqual(["address_check"]);
    expect(r.art).toMatchObject({
      values: {},
      flags: [],
      error: null,
      fileKey: null,
      previewKey: null,
      status: "purged",
      templateId,
    });
    for (const p of r.reprints) expect(p.note).toBeNull();
  }

  function expectKept(r: Awaited<ReturnType<typeof readBack>>, art: SeededArt) {
    expect(r.item?.personalization[0]?.answer).toBe(art.text);
    expect(r.item?.artworkKey).toBe(art.fileKey);
    expect(r.item?.artworkStatus).toBe("approved");
    expect(r.art?.values).toEqual({ name: art.text, photo: art.photoKey });
    expect(r.art?.status).toBe("approved");
    expect(r.reprints.every((p) => p.note !== null)).toBe(true);
  }

  it("clears a delivered unit's text, art and objects, keeps a unit still in production, and is idempotent", async () => {
    const o = await personalizedOrder(
      { shippedAt: days(40), deliveredAt: days(35), status: "partially_shipped" },
      ["delivered", "ready"],
    );
    const first = await purgeBuyerPii();
    expect(first).toMatchObject({ failedFiles: 0, failedCompanies: 0 });
    const a = await readBack(companyId, o.orderId, o.a);
    expectCleared(a);
    for (const k of [o.artA.fileKey, o.artA.previewKey, o.artA.photoKey])
      expect(await exists(k)).toBe(false);
    // Notes a person typed are cleared on the order clock; enum reasons and money stay.
    expect(a.order).toMatchObject({ buyerNote: null, holdNote: null, cancelNote: null });
    expect(a.refunds.map((r) => [r.note, r.amountCents])).toEqual([[null, 500]]);
    expect(a.reprints.map((r) => r.reason)).toEqual(["misprint"]);
    // Order facts stay.
    expect(a.order?.totalCents).toBe(5000);
    expect(a.item?.channelSku).toBe("TEST-SKU");

    const b = await readBack(companyId, o.orderId, o.b);
    expectKept(b, o.artB);
    for (const k of [o.artB.fileKey, o.artB.previewKey, o.artB.photoKey])
      expect(await exists(k)).toBe(true);

    // Second night: nothing left to clear for this order.
    const before = JSON.stringify(await readBack(companyId, o.orderId, o.a));
    await purgeBuyerPii();
    expect(JSON.stringify(await readBack(companyId, o.orderId, o.a))).toBe(before);
    expectKept(await readBack(companyId, o.orderId, o.b), o.artB);
  });

  it("covers orders whose buyer_pii row went in an earlier run", async () => {
    const o = await personalizedOrder(
      { shippedAt: days(45), status: "shipped" },
      ["shipped", "shipped"],
      { pii: false },
    );
    await purgeBuyerPii();
    expectCleared(await readBack(companyId, o.orderId, o.a));
    expectCleared(await readBack(companyId, o.orderId, o.b));
    expect(await exists(o.artB.fileKey)).toBe(false);
  });

  it("keeps everything inside the clock", async () => {
    const o = await personalizedOrder(
      { shippedAt: days(40), deliveredAt: days(10), status: "delivered" },
      ["delivered", "delivered"],
    );
    await purgeBuyerPii();
    const a = await readBack(companyId, o.orderId, o.a);
    expectKept(a, o.artA);
    expect(a.order?.buyerNote).toBe("Probe note A");
    expect(a.refunds[0]?.note).toBe("Probe note A");
    expect(await exists(o.artA.fileKey)).toBe(true);
  });

  it("starts a cancelled order's clock at cancelled_at", async () => {
    const old = await personalizedOrder({ cancelledAt: days(31), status: "cancelled" }, [
      "cancelled",
      "cancelled",
    ]);
    const recent = await personalizedOrder({ cancelledAt: days(5), status: "cancelled" }, [
      "cancelled",
      "cancelled",
    ]);
    await purgeBuyerPii();
    const o = await readBack(companyId, old.orderId, old.a);
    expectCleared(o);
    expect(o.order?.cancelNote).toBeNull();
    const r = await readBack(companyId, recent.orderId, recent.a);
    expectKept(r, recent.artA);
    expect(r.order?.cancelNote).toBe("Probe note A");
  });

  it("leaves a unit whose object delete failed for the next night", async () => {
    const o = await personalizedOrder({ shippedAt: days(40), status: "shipped" }, [
      "shipped",
      "shipped",
    ]);
    s3.failing.add(o.artA.photoKey);
    try {
      const res = await purgeBuyerPii();
      expect(res.failedFiles).toBe(1);
      const a = await readBack(companyId, o.orderId, o.a);
      // Keys and status kept, so the next run finds it again.
      expect(a.item?.artworkKey).toBe(o.artA.fileKey);
      expect(a.art?.status).toBe("approved");
      expect(a.art?.values.photo).toBe(o.artA.photoKey);
      expectCleared(await readBack(companyId, o.orderId, o.b));
    } finally {
      s3.failing.clear();
    }
    await purgeBuyerPii();
    expectCleared(await readBack(companyId, o.orderId, o.a));
    expect(await exists(o.artA.photoKey)).toBe(false);
  });

  it("never touches another company's orders", async () => {
    const other = (await createCompany()).id;
    const otherConn = (await createConnection(other)).id;
    const otherTpl = (await createNameTemplate(other)).id;
    const { order, items } = await createOrder(other, otherConn, { state: "delivered" });
    const item = items[0];
    if (!item) throw new Error("item");
    await withSystem((tx) =>
      tx
        .update(orders)
        .set({ shippedAt: days(3), deliveredAt: days(1) })
        .where(eq(orders.id, order.id)),
    );
    const art = await seedItemArt(other, item.id, otherTpl);
    await seedNotes(other, order.id, item.id, "Other note");
    const due = await personalizedOrder({ shippedAt: days(40), status: "shipped" }, [
      "shipped",
      "shipped",
    ]);
    await purgeBuyerPii();
    expectCleared(await readBack(companyId, due.orderId, due.a));
    const r = await readBack(other, order.id, item.id);
    expectKept(r, art);
    expect(r.order?.buyerNote).toBe("Other note");
    expect(await exists(art.fileKey)).toBe(true);
    // Under company B's tenant, company A's order ids change nothing (RLS).
    const again = await personalizedOrder({ shippedAt: days(40), status: "shipped" }, [
      "shipped",
      "shipped",
    ]);
    const res = await withTenant(other, (tx) =>
      redactBuyerText(tx, [again.orderId], { scope: "all" }),
    );
    expect(res).toEqual({
      personalizedItems: 0,
      artwork: 0,
      notes: 0,
      files: [],
      failedFiles: [],
      sharedPhotosKept: 0,
    });
    expectKept(await readBack(companyId, again.orderId, again.a), again.artA);
  });
});
