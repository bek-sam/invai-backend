import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  channelConnections,
  designFiles,
  designs,
  files,
  itemArtwork,
  orderItems,
  orders,
} from "../../db/schema";
import { objectKey, putObject } from "../../lib/s3";
import { createCompany, createConnection, createOrder } from "../../test/fixtures";
import { purgeBuyerPii } from "../orders/jobs";
import { createNameTemplate, exists, readBack, seedItemArt } from "./buyer-text.fixtures";
import { handlePrivacyRequest, redactStaleBuyerPii } from "./service";

/*
 * T-48-2 (B-303, decision 0027 amendment): a file the office attached by hand to one unit is
 * deleted with that unit's buyer data, unless it is not the company's, not a unit-art kind, or
 * some row outside this run still points at it. Driven through the real nightly handler, the
 * redact request and the 18-month sweep.
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

const days = (n: number) => new Date(Date.now() - n * 86400_000);
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let companyId: string;
let connId: string;
let templateId: string;

beforeAll(async () => {
  companyId = (await createCompany()).id;
  connId = (await createConnection(companyId)).id;
  templateId = (await createNameTemplate(companyId)).id;
});

const blob = (c: string, kind: string) => putObject(objectKey(c, kind, "png"), "x", "image/png");

/** One unit with a hand-set artwork key, on an order delivered `age` days ago. */
async function manualUnit(
  key: string,
  opts: { age?: number; state?: "delivered" | "ready"; company?: string; conn?: string } = {},
) {
  const c = opts.company ?? companyId;
  const { order, items } = await createOrder(c, opts.conn ?? connId);
  const item = items[0];
  if (!item) throw new Error("item");
  const age = opts.age ?? 40;
  await withSystem(async (tx) => {
    await tx
      .update(orders)
      .set({ shippedAt: days(age + 5), deliveredAt: days(age), status: "shipped" })
      .where(eq(orders.id, order.id));
    await tx
      .update(orderItems)
      .set({
        state: opts.state ?? "delivered",
        artworkKey: key,
        artworkPreviewKey: key,
        artworkStatus: "approved",
      })
      .where(eq(orderItems.id, item.id));
  });
  return { orderId: order.id, itemId: item.id, key, company: c };
}

const unitRow = async (u: { company: string; orderId: string; itemId: string }) =>
  (await readBack(u.company, u.orderId, u.itemId)).item;

async function registerFile(c: string, key: string) {
  await withTenant(c, (tx) =>
    tx.insert(files).values({ companyId: c, key, kind: "other", status: "ready" }),
  );
}

async function designUsing(key: string, c = companyId) {
  await withSystem(async (tx) => {
    const [d] = await tx
      .insert(designs)
      .values({ companyId: c, code: `D${uniq()}`, name: "Shop art" })
      .returning();
    if (!d) throw new Error("design");
    await tx.insert(designFiles).values({
      companyId: c,
      designId: d.id,
      placement: "front",
      fileKey: key,
      widthIn: 10,
      heightIn: 12,
    });
  });
}

describe("a hand-uploaded unit file on the 30-day clock", () => {
  it("AC1: deletes an other-kind file used by no one else, clears the unit and its file row, and is idempotent", async () => {
    const key = await blob(companyId, "other");
    await registerFile(companyId, key);
    const u = await manualUnit(key);
    const res = await purgeBuyerPii();
    expect(res).toMatchObject({ failedFiles: 0, failedCompanies: 0 });
    expect(await exists(key)).toBe(false);
    expect(await unitRow(u)).toMatchObject({
      artworkKey: null,
      artworkPreviewKey: null,
      artworkStatus: "purged",
    });
    const left = await withTenant(companyId, (tx) =>
      tx.select().from(files).where(eq(files.key, key)),
    );
    expect(left).toHaveLength(0);
    await purgeBuyerPii();
    expect(await unitRow(u)).toMatchObject({ artworkStatus: "purged" });
  });

  it("AC2: kept while another unit in production still uses it, deleted with the last one", async () => {
    const key = await blob(companyId, "other");
    const first = await manualUnit(key);
    const second = await manualUnit(key, { state: "ready", age: 1 });
    await purgeBuyerPii();
    expect(await exists(key)).toBe(true);
    expect(await unitRow(first)).toMatchObject({ artworkKey: null, artworkStatus: "purged" });
    expect(await unitRow(second)).toMatchObject({ artworkKey: key, artworkStatus: "approved" });
    // The second unit is delivered and past its clock: now the last user is purged.
    await withSystem(async (tx) => {
      await tx
        .update(orders)
        .set({ shippedAt: days(45), deliveredAt: days(40) })
        .where(eq(orders.id, second.orderId));
      await tx
        .update(orderItems)
        .set({ state: "delivered" })
        .where(eq(orderItems.id, second.itemId));
    });
    await purgeBuyerPii();
    expect(await exists(key)).toBe(false);
    expect(await unitRow(second)).toMatchObject({ artworkKey: null, artworkStatus: "purged" });
  });

  it("AC3: a design placement's file under /artwork/ is shop art: kept, the unit's keys are cleared", async () => {
    const key = await blob(companyId, "artwork");
    await designUsing(key);
    const u = await manualUnit(key);
    await purgeBuyerPii();
    expect(await exists(key)).toBe(true);
    expect(await unitRow(u)).toMatchObject({ artworkKey: null, artworkStatus: "purged" });
  });

  it("AC3: another unit's render (item_artwork) of that key keeps it", async () => {
    const other = await manualUnit(await blob(companyId, "artwork"), { state: "ready", age: 1 });
    const art = await seedItemArt(companyId, other.itemId, templateId);
    // Only the other unit's render row (item_artwork) points at the file, not its order_items row.
    await withSystem((tx) =>
      tx
        .update(orderItems)
        .set({ artworkKey: null, artworkPreviewKey: null })
        .where(eq(orderItems.id, other.itemId)),
    );
    const u = await manualUnit(art.fileKey);
    await purgeBuyerPii();
    expect(await exists(art.fileKey)).toBe(true);
    expect(await unitRow(u)).toMatchObject({ artworkKey: null, artworkStatus: "purged" });
    const still = await withTenant(companyId, (tx) =>
      tx.select().from(itemArtwork).where(eq(itemArtwork.orderItemId, other.itemId)),
    );
    expect(still[0]?.fileKey).toBe(art.fileKey);
  });

  it("AC4: a key of another company put straight into the row is never deleted; the other tenant is untouched", async () => {
    const b = (await createCompany()).id;
    const bConn = (await createConnection(b)).id;
    const foreign = await blob(b, "other"); // nothing in B points at it: only the company check saves it
    const a = await manualUnit(foreign); // the DB-level insert the API would refuse
    // Same relative path under each company: only A's own is deleted; B's unit still uses its own.
    const rel = `other/${uniq()}.png`;
    const aKey = await putObject(`${companyId}/${rel}`, "a", "image/png");
    const bKey = await putObject(`${b}/${rel}`, "b", "image/png");
    const aOwn = await manualUnit(aKey);
    const bUnit = await manualUnit(bKey, { company: b, conn: bConn, state: "ready", age: 1 });
    await purgeBuyerPii();
    expect(await exists(foreign)).toBe(true);
    expect(await unitRow(a)).toMatchObject({ artworkKey: null, artworkStatus: "purged" });
    expect(await exists(aKey)).toBe(false);
    expect(await unitRow(aOwn)).toMatchObject({ artworkStatus: "purged" });
    expect(await exists(bKey)).toBe(true);
    expect(await unitRow(bUnit)).toMatchObject({ artworkKey: bKey });
  });

  it("only unit-art kinds are deleted: an unreferenced design-kind key stays", async () => {
    const key = await blob(companyId, "design");
    const u = await manualUnit(key);
    await purgeBuyerPii();
    expect(await exists(key)).toBe(true);
    expect(await unitRow(u)).toMatchObject({ artworkKey: null, artworkStatus: "purged" });
  });

  it("AC5: a failed delete leaves the unit as it was and the next night retries", async () => {
    const key = await blob(companyId, "other");
    const u = await manualUnit(key);
    s3.failing.add(key);
    try {
      const res = await purgeBuyerPii();
      expect(res.failedFiles).toBeGreaterThanOrEqual(1);
      expect(await unitRow(u)).toMatchObject({ artworkKey: key, artworkStatus: "approved" });
      expect(await exists(key)).toBe(true);
    } finally {
      s3.failing.clear();
    }
    await purgeBuyerPii();
    expect(await exists(key)).toBe(false);
    expect(await unitRow(u)).toMatchObject({ artworkKey: null, artworkStatus: "purged" });
  });
});

describe("the same rule on a redact request and the 18-month clock", () => {
  it("AC6: customers/redact deletes an unshared hand-uploaded file of a unit still in production and keeps a design's", async () => {
    const shop = `t482-${uniq()}.myshopify.com`;
    const sc = await createConnection(companyId, "shopify");
    await withSystem((tx) =>
      tx
        .update(channelConnections)
        .set({ externalShopId: shop, status: "connected" })
        .where(eq(channelConnections.id, sc.id)),
    );
    const mine = await blob(companyId, "other");
    const shopArt = await blob(companyId, "artwork");
    await designUsing(shopArt);
    const a = await manualUnit(mine, { state: "ready", age: 1, conn: sc.id });
    const b = await manualUnit(shopArt, { state: "ready", age: 1, conn: sc.id });
    const channelIds = await withTenant(companyId, async (tx) =>
      (await tx.select({ id: orders.channelOrderId }).from(orders).where(eq(orders.id, a.orderId)))
        .concat(
          await tx
            .select({ id: orders.channelOrderId })
            .from(orders)
            .where(eq(orders.id, b.orderId)),
        )
        .map((r) => r.id),
    );
    await handlePrivacyRequest({
      channel: "shopify",
      shopDomain: shop,
      deliveryId: `t482-${uniq()}`,
      request: {
        topic: "customers/redact",
        channelCustomerId: "c-1",
        channelRequestId: "r-1",
        channelOrderIds: channelIds,
      },
    });
    expect(await exists(mine)).toBe(false);
    expect(await exists(shopArt)).toBe(true);
    expect(await unitRow(a)).toMatchObject({ artworkKey: null, artworkStatus: "purged" });
    expect(await unitRow(b)).toMatchObject({ artworkKey: null, artworkStatus: "purged" });
  });

  it("AC6: the 18-month sweep applies the same rule", async () => {
    const own = await blob(companyId, "other");
    const art = await blob(companyId, "artwork");
    await designUsing(art);
    const a = await manualUnit(own, { state: "ready", age: 1 });
    const b = await manualUnit(art, { state: "ready", age: 1 });
    await withSystem((tx) =>
      Promise.all(
        [a, b].map((u) =>
          tx
            .update(orders)
            .set({ placedAt: days(600) })
            .where(eq(orders.id, u.orderId)),
        ),
      ),
    );
    await redactStaleBuyerPii();
    expect(await exists(own)).toBe(false);
    expect(await exists(art)).toBe(true);
    expect(await unitRow(a)).toMatchObject({ artworkKey: null, artworkStatus: "purged" });
    expect(await unitRow(b)).toMatchObject({ artworkKey: null, artworkStatus: "purged" });
  });
});
