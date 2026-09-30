import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createCompany } from "../../test/fixtures";
import { withSystem } from "../client";
import { digests } from "../schema";
import { buildWeeklyDigest } from "./weekly-digest";

/*
 * T-23-8 (B-207): the seed calls `buildWeeklyDigest` for the demo shop's last complete ISO week.
 * A quiet company (no orders, fresh from `createCompany`) still gets a digest row -- `buildDigest`
 * marks it `skipped_quiet` rather than skipping the row entirely -- so this proves the call
 * succeeds and, more importantly, that calling it again for the same shop and week never creates
 * a second row (AC2: a second seed run must not double the digest).
 */
describe("buildWeeklyDigest", () => {
  it("builds one digest for the shop's last complete week, and a second call is a no-op", async () => {
    const company = await createCompany();
    const at = new Date("2026-09-29T12:00:00.000Z");

    const first = await buildWeeklyDigest(company.id, company.timezone, at);
    expect(["ready", "skipped_quiet"]).toContain(first.status);

    const second = await buildWeeklyDigest(company.id, company.timezone, at);
    expect(second.weekKey).toBe(first.weekKey);
    // `buildDigest` reports the second call as `exists` once the first has settled.
    expect(second.status).toBe("exists");

    const rows = await withSystem((tx) =>
      tx
        .select({ id: digests.id })
        .from(digests)
        .where(and(eq(digests.companyId, company.id), eq(digests.weekKey, first.weekKey))),
    );
    expect(rows).toHaveLength(1);
  });
});
