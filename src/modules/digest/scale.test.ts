import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem } from "../../db/client";
import { createCompany } from "../../test/fixtures";
import { buildDigest } from "./build";
import { sweep } from "./jobs";

/*
 * Budget check (card item 12, spec AC29's smaller synthetic run): one 1,000-orders/day shop builds
 * in < 60 s, and a sweep over 1,000 small shops finishes well inside 30 minutes. Opt-in only
 * (`DIGEST_SCALE=1`) and meant for its own database: it inserts ~70k orders. QA runs the full
 * AC29 profile separately.
 */

const run = process.env.DIGEST_SCALE === "1";
const MON_0705 = new Date("2026-09-28T14:05:00.000Z");
const FROM = "2026-07-27T07:00:00Z"; // 9 weeks before 2026-09-28 (Phoenix midnight)

describe.skipIf(!run)("digest scale budget", () => {
  it("a 1,000 orders/day shop builds within 60 s", async () => {
    const c = await createCompany({ name: "T-19-3 Scale Large" });
    const perDay = 1_000;
    const days = 63;
    await withSystem(async (tx) => {
      await tx.execute(sql`
        insert into channel_connections (company_id, channel, name, status, mode, provider)
        values (${c.id}, 'etsy', 'Etsy', 'connected', 'api', 'mock'),
               (${c.id}, 'amazon', 'Amazon', 'connected', 'api', 'mock')`);
      await tx.execute(sql`
        insert into orders (company_id, connection_id, channel, channel_order_id, order_no, status,
                            placed_at, ship_by, shipped_at, subtotal_cents, total_cents, item_count)
        select ${c.id}, cc.id, cc.channel, 'o' || g, 'N' || g,
               case when g % 50 = 0 then 'new' else 'shipped' end,
               ${FROM}::timestamptz + (g * (86400.0 / ${perDay})) * interval '1 second',
               ${FROM}::timestamptz + (g * (86400.0 / ${perDay})) * interval '1 second' + interval '2 days',
               case when g % 50 = 0 then null
                    else ${FROM}::timestamptz + (g * (86400.0 / ${perDay})) * interval '1 second'
                         + (case when g % 17 = 0 then interval '3 days' else interval '30 hours' end) end,
               2500, 2500, 1
        from generate_series(1, ${perDay * days}) g
        join channel_connections cc on cc.company_id = ${c.id}
          and cc.channel = case when g % 3 = 0 then 'amazon' else 'etsy' end`);
      await tx.execute(sql`
        insert into order_items (company_id, order_id, channel_sku, title, state, ship_by)
        select company_id, id, 'SKU', 'Tee', 'packed', ship_by from orders where company_id = ${c.id}`);
      await tx.execute(sql`
        insert into profit_lines (company_id, order_id, order_item_id, channel, revenue_cents,
                                  channel_fees_cents, blank_cost_cents, net_cents, margin_pct, placed_at)
        select o.company_id, o.id, oi.id, o.channel, 2500, 300, 400, 1800, 0.72, o.placed_at
        from orders o join order_items oi on oi.order_id = o.id where o.company_id = ${c.id}`);
      await tx.execute(sql`analyze orders; analyze order_items; analyze profit_lines`);
    });
    const t0 = performance.now();
    const out = await buildDigest(c.id, "2026-W39", MON_0705);
    const ms = performance.now() - t0;
    process.stdout.write(
      `\n[digest-scale] large shop build: ${Math.round(ms)} ms (${out.status})\n`,
    );
    expect(out.status).toBe("ready");
    expect(ms).toBeLessThan(60_000);
  }, 300_000);

  it("a sweep over 1,000 small shops", async () => {
    await withSystem(async (tx) => {
      await tx.execute(sql`
        insert into companies (name, slug, type, plan, timezone)
        select 'T-19-3 Scale Small ' || g, 't193-small-' || g || '-' || substr(md5(random()::text), 1, 6),
               'shop', 'trial', 'America/Phoenix'
        from generate_series(1, 1000) g`);
      await tx.execute(sql`
        insert into channel_connections (company_id, channel, name, status, mode, provider)
        select id, 'etsy', 'Etsy', 'connected', 'api', 'mock' from companies
        where name like 'T-19-3 Scale Small %'`);
      await tx.execute(sql`
        insert into orders (company_id, connection_id, channel, channel_order_id, order_no, status,
                            placed_at, ship_by, shipped_at, subtotal_cents, total_cents, item_count)
        select c.id, cc.id, 'etsy', 'o' || g, 'N' || g, 'shipped',
               '2026-09-23T15:00:00Z'::timestamptz + g * interval '1 hour',
               '2026-09-25T15:00:00Z'::timestamptz + g * interval '1 hour',
               '2026-09-24T15:00:00Z'::timestamptz, 2500, 2500, 1
        from companies c join channel_connections cc on cc.company_id = c.id,
             generate_series(1, 3) g
        where c.name like 'T-19-3 Scale Small %'`);
      await tx.execute(sql`
        insert into order_items (company_id, order_id, channel_sku, title, state, ship_by)
        select o.company_id, o.id, 'SKU', 'Tee', 'packed', o.ship_by from orders o
        join companies c on c.id = o.company_id where c.name like 'T-19-3 Scale Small %'`);
      await tx.execute(sql`
        insert into profit_lines (company_id, order_id, order_item_id, channel, revenue_cents,
                                  net_cents, margin_pct, placed_at)
        select o.company_id, o.id, oi.id, 'etsy', 2500, 1800, 0.72, o.placed_at
        from orders o join order_items oi on oi.order_id = o.id
        join companies c on c.id = o.company_id where c.name like 'T-19-3 Scale Small %'`);
    });
    const t0 = performance.now();
    const out = await sweep(MON_0705);
    const ms = performance.now() - t0;
    process.stdout.write(
      `\n[digest-scale] sweep: ${out.built} built, ${out.failed} failed in ${Math.round(ms)} ms\n`,
    );
    expect(out.failed).toBe(0);
    expect(out.built).toBeGreaterThanOrEqual(1_000);
    expect(ms).toBeLessThan(30 * 60_000);
    // A second sweep finds nothing left to build (no duplicates).
    expect((await sweep(MON_0705)).built).toBe(0);
  }, 1_800_000);
});
