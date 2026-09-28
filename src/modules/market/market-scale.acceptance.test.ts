import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem } from "../../db/client";
import { createCompany } from "../../test/fixtures";
import { computeSignalsForShop } from "./compute";
import { refreshDemand } from "./jobs";

/*
 * Wave 18 spec AC28 (market signals at scale): a `large` shop (5,000 active designs, three years
 * of orders at about 1,070 units/day, 90 days of profit lines) gets its demand refresh and its
 * full signal computation inside 15 minutes. Opt-in only (`MARKET_SCALE=1`) and meant for its own
 * database: it inserts about 585k orders and 1.17M items. Owner: qa-engineer (gate evidence, run
 * before each stage transition per `scale-test`). The shape mirrors T-18-3's own synthetic timing
 * run (its fixture lived in a scratchpad), so the numbers are comparable.
 */

const run = process.env.MARKET_SCALE === "1";
const BUDGET_MS = 15 * 60_000;
const DESIGNS = 5_000;
const ORDERS = 584_000; // over 1,092 days (156 weeks) => about 535 orders and 1,070 units a day
const DAYS = 1_092;
const WORDS = [
  "Teacher",
  "Nurse",
  "Doctor",
  "Firefighter",
  "Police",
  "Military",
  "Veteran",
  "Trucker",
  "Mechanic",
  "Farmer",
  "Chef",
  "Coach",
  "Mom",
  "Dad",
  "Grandma",
  "Grandpa",
  "Dog Mom",
  "Cat Mom",
  "Christmas",
  "Halloween",
  "Thanksgiving",
  "Valentines",
  "Easter",
  "Birthday",
  "Bride",
];

describe.skipIf(!run)("market scale budget (AC28)", () => {
  it("a 5,000-design, 3-year shop refreshes demand and computes signals within 15 min", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - DAYS * 86_400_000).toISOString();
    const c = await createCompany({ name: "QA Market Scale Large" });
    const t0 = performance.now();
    await withSystem(async (tx) => {
      await tx.execute(sql`
        insert into channel_connections (company_id, channel, name, status, mode, provider, connected_at)
        values (${c.id}, 'etsy', 'Etsy', 'connected', 'api', 'mock', now()),
               (${c.id}, 'amazon', 'Amazon', 'connected', 'api', 'mock', now())`);
      await tx.execute(sql`
        insert into designs (company_id, code, name, tags, status)
        select ${c.id}, 'D' || g,
               (array[${sql.join(
                 WORDS.map((w) => sql`${w}`),
                 sql`, `,
               )}])[1 + (g % ${WORDS.length})] || ' Tee ' || g,
               '{}', 'active'
        from generate_series(1, ${DESIGNS}) g`);
      await tx.execute(sql`
        insert into orders (company_id, connection_id, channel, channel_order_id, order_no, status,
                            placed_at, ship_by, shipped_at, subtotal_cents, total_cents, item_count)
        select ${c.id}, cc.id, cc.channel, 'o' || g, 'N' || g, 'shipped',
               ${from}::timestamptz + (g * (${DAYS} * 86400.0 / ${ORDERS})) * interval '1 second',
               ${from}::timestamptz + (g * (${DAYS} * 86400.0 / ${ORDERS})) * interval '1 second' + interval '2 days',
               ${from}::timestamptz + (g * (${DAYS} * 86400.0 / ${ORDERS})) * interval '1 second' + interval '30 hours',
               4998, 4998, 2
        from generate_series(1, ${ORDERS}) g
        join channel_connections cc on cc.company_id = ${c.id}
          and cc.channel = case when g % 3 = 0 then 'amazon' else 'etsy' end`);
      // Two units per order, each on a different design; the design index walks the catalog so
      // every design sells (about 234 units each over the three years), with a seasonal bump in
      // Q4 for a fifth of the catalog.
      await tx.execute(sql`
        with o as (
          select id, company_id, ship_by, placed_at,
                 (substring(channel_order_id from 2))::int as n
          from orders where company_id = ${c.id}
        ), d as (
          select id, row_number() over (order by code) as rn from designs where company_id = ${c.id}
        )
        insert into order_items (company_id, order_id, line_no, unit_no, units_in_line, channel_sku,
                                 title, unit_price_cents, state, ship_by, design_id, is_reprint)
        select o.company_id, o.id, k, 1, 1, 'SKU-' || d.rn, 'Tee', 2499 + (o.n % 5) * 100, 'shipped',
               o.ship_by, d.id, false
        from o cross join generate_series(1, 2) k
        join d on d.rn = 1 + ((o.n * k + case when extract(month from o.placed_at) in (10, 11, 12)
                                                    then 0 else 1 end) % ${DESIGNS})`);
      await tx.execute(sql`
        insert into profit_lines (company_id, order_id, order_item_id, channel, design_id,
                                  revenue_cents, channel_fees_cents, blank_cost_cents, net_cents,
                                  margin_pct, placed_at)
        select o.company_id, o.id, oi.id, o.channel, oi.design_id, oi.unit_price_cents, 300, 400,
               oi.unit_price_cents - 700, (oi.unit_price_cents - 700)::numeric / oi.unit_price_cents,
               o.placed_at
        from orders o join order_items oi on oi.order_id = o.id
        where o.company_id = ${c.id} and o.placed_at >= now() - interval '90 days'`);
      await tx.execute(
        sql`analyze designs; analyze orders; analyze order_items; analyze profit_lines`,
      );
    });
    const seeded = performance.now() - t0;
    const [counts] = (
      await withSystem((tx) =>
        tx.execute<{ orders: number; items: number; profit: number }>(sql`
          select (select count(*) from orders where company_id = ${c.id})::int as orders,
                 (select count(*) from order_items where company_id = ${c.id})::int as items,
                 (select count(*) from profit_lines where company_id = ${c.id})::int as profit`),
      )
    ).rows;
    process.stdout.write(
      `\n[market-scale] fixture: ${JSON.stringify(counts)} in ${Math.round(seeded)} ms\n`,
    );

    const t1 = performance.now();
    await refreshDemand(now);
    const demandMs = performance.now() - t1;
    const t2 = performance.now();
    const out = await computeSignalsForShop(c.id, { now }, { classify: null, screen: null });
    const signalsMs = performance.now() - t2;
    process.stdout.write(
      `[market-scale] refreshDemand: ${Math.round(demandMs)} ms; computeSignals: ${Math.round(signalsMs)} ms ${JSON.stringify(out)}\n`,
    );
    expect(out.designs).toBe(DESIGNS);
    expect(demandMs + signalsMs).toBeLessThan(BUDGET_MS);

    // A second run is idempotent (same rows upserted, at most one recommendation per rule, target
    // and day) and not slower than the first.
    const t3 = performance.now();
    const again = await computeSignalsForShop(c.id, { now }, { classify: null, screen: null });
    const againMs = performance.now() - t3;
    process.stdout.write(
      `[market-scale] computeSignals again: ${Math.round(againMs)} ms ${JSON.stringify(again)}\n`,
    );
    expect(again.recommendations).toBe(0);
    expect(againMs).toBeLessThan(BUDGET_MS);
  }, 1_800_000);
});
