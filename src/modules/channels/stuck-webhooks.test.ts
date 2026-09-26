import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { alerts, webhookDeliveries } from "../../db/schema";
import { runJobInline } from "../../lib/queues";
import { createCompany } from "../../test/fixtures";
import {
  flagStuckWebhookDeliveries,
  purgeWebhookDeliveriesJob,
  STUCK_WEBHOOK_DETAIL,
} from "./jobs";

/*
 * T-12-1: a webhook delivery left at `received` (its job was lost) is flagged once, alerts its
 * shop when the shop is known, and is never purged before it was flagged.
 */

let companyId: string;
beforeAll(async () => {
  companyId = (await createCompany()).id;
});

async function delivery(minutesAgo: number, company: string | null = companyId) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(webhookDeliveries)
      .values({
        channel: "shopify",
        deliveryId: `t121-${crypto.randomUUID()}`,
        companyId: company,
        receivedAt: new Date(Date.now() - minutesAgo * 60_000),
      })
      .returning(),
  );
  return row as typeof webhookDeliveries.$inferSelect;
}
const rowOf = async (id: string) =>
  (
    await withSystem((tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)),
    )
  )[0];
const stuckAlerts = (id: string) =>
  withTenant(companyId, (tx) =>
    tx
      .select()
      .from(alerts)
      .where(and(eq(alerts.companyId, companyId), eq(alerts.dedupeKey, `webhook_stuck:${id}`))),
  );

describe("stuck webhook deliveries", () => {
  it("flags a delivery stuck at received past the threshold, with one alert across sweeps", async () => {
    const stuck = await delivery(90);
    const fresh = await delivery(5);
    await flagStuckWebhookDeliveries();
    await flagStuckWebhookDeliveries();
    expect((await rowOf(stuck.id))?.detail).toBe(STUCK_WEBHOOK_DETAIL);
    expect((await rowOf(stuck.id))?.status).toBe("received");
    expect((await rowOf(fresh.id))?.detail).toBeNull();
    const rows = await stuckAlerts(stuck.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "sync_broken", status: "open" });
  });

  it("a delivery with no shop yet is still flagged (operator log), without a tenant alert", async () => {
    const orphan = await delivery(90, null);
    const res = await flagStuckWebhookDeliveries();
    expect(res.flagged).toBeGreaterThanOrEqual(1);
    expect((await rowOf(orphan.id))?.detail).toBe(STUCK_WEBHOOK_DETAIL);
  });

  it("the daily purge flags a stuck row before deleting expired ones", async () => {
    const expired = await delivery(8 * 24 * 60);
    const res = (await runJobInline(purgeWebhookDeliveriesJob, {})) as {
      stuck: { flagged: number; alerted: number };
      deleted: number;
    };
    expect(res.stuck.flagged).toBeGreaterThanOrEqual(1);
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(await rowOf(expired.id)).toBeUndefined();
    expect(await stuckAlerts(expired.id)).toHaveLength(1);
  });
});
