import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "../db/client";
import { alerts } from "../db/schema";
import { redis } from "../lib/queues";
import { createCompany } from "../test/fixtures";
import { assertSpendAvailable, resetFailOpenThrottle } from "./breaker";

/*
 * T-12-1 (wave 8 T-8-2 follow-up): when Valkey fails and the spend check fails open, the calling
 * company gets one critical `ai_breaker_fail_open` alert, not just a log line.
 */

const caps = { platform: 1_000, tenant: 100 };
const failOpenAlerts = (companyId: string) =>
  withTenant(companyId, (tx) =>
    tx
      .select()
      .from(alerts)
      .where(and(eq(alerts.companyId, companyId), eq(alerts.kind, "ai_breaker_fail_open"))),
  );

afterEach(() => {
  vi.restoreAllMocks();
  resetFailOpenThrottle();
});

describe("AI spend breaker fail-open alert", () => {
  it("a rejected Valkey call lets the call through and raises one alert", async () => {
    const shop = await createCompany();
    const mget = vi.spyOn(redis, "mget").mockRejectedValue(new Error("ECONNREFUSED"));
    const now = new Date("2026-09-26T10:15:00Z");
    await expect(assertSpendAvailable(shop.id, now, caps)).resolves.toBeUndefined();
    // More calls during the same outage don't pile up alerts.
    await assertSpendAvailable(shop.id, new Date(now.getTime() + 60_000), caps);
    await assertSpendAvailable(shop.id, new Date(now.getTime() + 120_000), caps);
    expect(mget).toHaveBeenCalledTimes(3);

    const rows = await failOpenAlerts(shop.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      severity: "critical",
      status: "open",
      dedupeKey: "ai_breaker_fail_open:2026-09-26T10",
    });
    expect(rows[0]?.data).toMatchObject({ reason: "ECONNREFUSED" });
  });

  it("no alert while Valkey answers", async () => {
    const shop = await createCompany();
    await expect(assertSpendAvailable(shop.id, new Date(), caps)).resolves.toBeUndefined();
    expect(await failOpenAlerts(shop.id)).toHaveLength(0);
  });
});
