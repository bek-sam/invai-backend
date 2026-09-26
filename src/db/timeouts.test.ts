import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, systemDb } from "./client";

/*
 * T-12-2 (B-16): role-level Postgres timeouts (drizzle/0025_role_level_timeouts.sql), set on the
 * role so they survive any pooler in front later (research §1/§2.2). Two things to check:
 * 1. The migration actually set the right defaults for each role.
 * 2. When a query does run longer than its session's statement_timeout, Postgres itself cancels
 *    it -- the app never has to detect or kill a hung query -- and the JS side sees a normal,
 *    fast rejection (a typed Postgres error, not a hang) rather than waiting out the query.
 */
describe("role-level statement/lock/idle timeouts", () => {
  it("invai_app (the app role) has the 15s/30s/5s defaults from the migration", async () => {
    const rows = await db.execute<{ statement_timeout: string; idle: string; lock: string }>(
      sql`select
            current_setting('statement_timeout') as statement_timeout,
            current_setting('idle_in_transaction_session_timeout') as idle,
            current_setting('lock_timeout') as lock`,
    );
    const row = rows.rows[0];
    expect(row?.statement_timeout).toBe("15s");
    expect(row?.idle).toBe("30s");
    expect(row?.lock).toBe("5s");
  });

  it("invai (the owner/system role) has a longer 5min statement_timeout for reports/purge jobs", async () => {
    const rows = await systemDb.execute<{ statement_timeout: string }>(
      sql`select current_setting('statement_timeout') as statement_timeout`,
    );
    expect(rows.rows[0]?.statement_timeout).toBe("5min");
  });

  it("Postgres cancels a query that outlives its session's statement_timeout, fast, with a typed error", async () => {
    const start = Date.now();
    // SET LOCAL keeps this scoped to the one test transaction; it stands in for the role default
    // (15s) so the test doesn't have to wait 15 real seconds to see the same cancellation.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '150ms'`);
        await tx.execute(sql`select pg_sleep(2)`);
      }),
    ).rejects.toMatchObject({ cause: { code: "57014" } }); // query_canceled: Postgres cut it off
    // Cancelled well before pg_sleep(2) would have returned on its own -- not a hang.
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
