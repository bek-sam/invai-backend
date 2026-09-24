import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, files, orders } from "../../db/schema";
import { headObject, objectKey, putObject } from "../../lib/s3";
import { createCompany, createConnection, createOrder } from "../../test/fixtures";
import { purgeBuyerPii, purgePiiObjects } from "./jobs";

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
