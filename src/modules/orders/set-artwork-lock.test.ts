import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { orderItems, orders } from "../../db/schema";
import { objectKey, putObject } from "../../lib/s3";
import { createCompany, createConnection, createOrder, tenantContext } from "../../test/fixtures";
import { exists } from "../privacy/buyer-text.fixtures";
import { redactBuyerText } from "../privacy/service";
import { setItemArtwork } from "./service";

/*
 * T-48-2 (decision 0027 amendment, architect A1): setItemArtwork and the buyer-data purge take
 * the same advisory lock on the file key. The upload requires the object to exist.
 */
let companyId: string;
let connId: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ctx = () => tenantContext(companyId, null, "office");

beforeAll(async () => {
  companyId = (await createCompany()).id;
  connId = (await createConnection(companyId)).id;
});

async function unit(set: Partial<typeof orderItems.$inferInsert> = {}) {
  const { order, items } = await createOrder(companyId, connId);
  const item = items[0];
  if (!item) throw new Error("item");
  await withSystem(async (tx) => {
    await tx
      .update(orderItems)
      .set({ state: "ready", ...set })
      .where(eq(orderItems.id, item.id));
    await tx
      .update(orders)
      .set({ shippedAt: new Date(Date.now() - 40 * 86400_000), status: "shipped" })
      .where(eq(orders.id, order.id));
  });
  return { orderId: order.id, itemId: item.id };
}
const keyOf = async (itemId: string) =>
  (
    await withTenant(companyId, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.id, itemId)),
    )
  )[0]?.artworkKey;

describe("setItemArtwork and the purge share a lock on the file", () => {
  it("attaches an object that exists", async () => {
    const key = await putObject(objectKey(companyId, "other", "png"), "x", "image/png");
    const u = await unit();
    await withTenant(companyId, (tx) => setItemArtwork(tx, ctx(), { id: u.itemId, fileKey: key }));
    expect(await keyOf(u.itemId)).toBe(key);
  });

  it("refuses a key with no object: NOT_FOUND, the unit is unchanged", async () => {
    const u = await unit();
    await expect(
      withTenant(companyId, (tx) =>
        setItemArtwork(tx, ctx(), {
          id: u.itemId,
          fileKey: objectKey(companyId, "other", "png"),
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await keyOf(u.itemId)).toBeNull();
  });

  it("(h) waits for a purge in flight on the same file, then gets NOT_FOUND", async () => {
    const key = await putObject(objectKey(companyId, "other", "png"), "x", "image/png");
    const old = await unit({ artworkKey: key, artworkPreviewKey: key, artworkStatus: "approved" });
    const fresh = await unit();
    const events: string[] = [];
    let purging!: () => void;
    const started = new Promise<void>((r) => {
      purging = r;
    });
    // The purge deletes the object, then holds its transaction open.
    const purge = withTenant(companyId, async (tx) => {
      await redactBuyerText(tx, [old.orderId], { scope: "all" });
      purging();
      await sleep(600);
      events.push("purge-commit");
    });
    await started;
    const attach = withTenant(companyId, (tx) =>
      setItemArtwork(tx, ctx(), { id: fresh.itemId, fileKey: key }),
    ).then(
      () => events.push("attach-ok"),
      (e) => events.push(`attach-${(e as { code?: string }).code}`),
    );
    await Promise.all([purge, attach]);
    expect(events).toEqual(["purge-commit", "attach-NOT_FOUND"]);
    expect(await exists(key)).toBe(false);
    expect(await keyOf(fresh.itemId)).toBeNull();
  });

  it("a purge started while an upload holds the file waits, then keeps the now-shared file", async () => {
    const key = await putObject(objectKey(companyId, "other", "png"), "x", "image/png");
    const old = await unit({ artworkKey: key, artworkPreviewKey: key, artworkStatus: "approved" });
    const fresh = await unit();
    const events: string[] = [];
    let attached!: () => void;
    const started = new Promise<void>((r) => {
      attached = r;
    });
    const attach = withTenant(companyId, async (tx) => {
      await setItemArtwork(tx, ctx(), { id: fresh.itemId, fileKey: key });
      attached();
      await sleep(600);
      events.push("attach-commit");
    });
    await started;
    const purge = withTenant(companyId, (tx) =>
      redactBuyerText(tx, [old.orderId], { scope: "all" }),
    ).then(() => events.push("purge-done"));
    await Promise.all([attach, purge]);
    expect(events).toEqual(["attach-commit", "purge-done"]);
    expect(await exists(key)).toBe(true);
    expect(await keyOf(old.itemId)).toBeNull();
    expect(await keyOf(fresh.itemId)).toBe(key);
  });
});
