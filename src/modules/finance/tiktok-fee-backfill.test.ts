import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem } from "../../db/client";
import { costSettings } from "../../db/schema";
import type { ChannelFeeTable } from "../../db/schema/finance";
import { createCompany } from "../../test/fixtures";
import { usesSchedule } from "./fees";

/*
 * B-164 (T-22-5): migration 0035 moves saved TikTok fee tables still at the old default (8) to
 * the verified 6, so they keep using the schedule. The test DB already ran it on empty tables;
 * this runs the same SQL again on rows written the old way (it must also be safe to re-run).
 */
const MIGRATION = new URL("../../../drizzle/0035_finance_tiktok_fee_6.sql", import.meta.url);

const table = (channel: string, transactionPct: number): ChannelFeeTable => ({
  channel,
  transactionPct,
  perOrderCents: 0,
  paymentPct: 0,
  paymentFixedCents: 0,
  listingFeeCents: 0,
});

async function saveTables(companyId: string, feeTables: ChannelFeeTable[]) {
  await withSystem((tx) =>
    tx
      .insert(costSettings)
      .values({ companyId, feeTables })
      .onConflictDoUpdate({ target: costSettings.companyId, set: { feeTables } }),
  );
}

const tablesOf = async (companyId: string) =>
  (
    await withSystem((tx) =>
      tx
        .select({ t: costSettings.feeTables })
        .from(costSettings)
        .where(eq(costSettings.companyId, companyId)),
    )
  )[0]?.t;

describe("TikTok fee backfill (0035)", () => {
  it("moves a saved tiktok 8 to 6, leaves other channels, order and a shop's own rate", async () => {
    const stale = (await createCompany({ name: "Fee stale" })).id;
    const custom = (await createCompany({ name: "Fee custom" })).id;
    await saveTables(stale, [table("etsy", 8), table("tiktok", 8), table("walmart", 15)]);
    await saveTables(custom, [table("tiktok", 7.5), table("amazon", 15)]);

    const run = () => withSystem((tx) => tx.execute(sql.raw(readFileSync(MIGRATION, "utf8"))));
    await run();
    await run();

    const after = await tablesOf(stale);
    expect(after?.map((t) => [t.channel, t.transactionPct])).toEqual([
      ["etsy", 8],
      ["tiktok", 6],
      ["walmart", 15],
    ]);
    const tiktok = after?.find((t) => t.channel === "tiktok");
    expect(tiktok && usesSchedule(tiktok)).toBe(true);
    expect((await tablesOf(custom))?.map((t) => t.transactionPct)).toEqual([7.5, 15]);
  });
});
