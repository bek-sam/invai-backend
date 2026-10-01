import { describe, expect, it } from "vitest";
import { assertSafeToSeed } from "./index";

/*
 * T-P6-1 (B-219): seeding any database other than the shared `invai` must refuse, before any
 * insert, when SEED_OUTPUT_FILE is unset -- a scratch seed must never overwrite the shared
 * `invai-backend/seed-output.json` (incident 2026-10-01 T-P5-1). `invai` itself must stay
 * seedable with no SEED_OUTPUT_FILE set, exactly as today.
 *
 * Round 2 (review finding 1): the seed writes through two pools, DATABASE_URL (auth/signUp) and
 * MIGRATION_DATABASE_URL (systemDb). Both must name `invai`, or SEED_OUTPUT_FILE must be set --
 * a mixed env (one pinned to `invai`, the other scratch) must refuse too, not just the case
 * where both are scratch.
 *
 * Importing "./index" here never runs the seed: main() is only invoked when this file is the
 * script node/tsx was started with (`fileURLToPath(import.meta.url) === process.argv[1]`), which
 * is false under the test runner.
 */
describe("assertSafeToSeed", () => {
  const DB_URL = (name: string) => `postgres://invai:invai@localhost:5432/${name}`;

  it("allows the shared invai database (both URLs) with no SEED_OUTPUT_FILE", () => {
    expect(() => assertSafeToSeed(DB_URL("invai"), DB_URL("invai"), undefined)).not.toThrow();
  });

  it("allows the shared invai database even with SEED_OUTPUT_FILE set", () => {
    expect(() =>
      assertSafeToSeed(DB_URL("invai"), DB_URL("invai"), "/tmp/whatever.json"),
    ).not.toThrow();
  });

  it("refuses another database with no SEED_OUTPUT_FILE", () => {
    expect(() =>
      assertSafeToSeed(DB_URL("invai_p6_reset"), DB_URL("invai_p6_reset"), undefined),
    ).toThrow(/refusing: seeding invai_p6_reset would overwrite the shared seed-output\.json/);
  });

  it("refuses another database when SEED_OUTPUT_FILE is blank", () => {
    expect(() =>
      assertSafeToSeed(DB_URL("invai_p6_reset"), DB_URL("invai_p6_reset"), "   "),
    ).toThrow(/SEED_OUTPUT_FILE/);
  });

  it("allows another database with SEED_OUTPUT_FILE set", () => {
    expect(() =>
      assertSafeToSeed(
        DB_URL("invai_p6_reset"),
        DB_URL("invai_p6_reset"),
        "/tmp/p6-1-seed-output.json",
      ),
    ).not.toThrow();
  });

  // Round 2 (AC5, review finding 1): mixed envs -- one URL pinned to `invai`, the other scratch.
  it("refuses when DATABASE_URL is scratch but MIGRATION_DATABASE_URL is invai, with no SEED_OUTPUT_FILE", () => {
    expect(() => assertSafeToSeed(DB_URL("invai_p6_reset"), DB_URL("invai"), undefined)).toThrow(
      /refusing: seeding invai_p6_reset would overwrite the shared seed-output\.json/,
    );
  });

  it("refuses when MIGRATION_DATABASE_URL is scratch but DATABASE_URL is invai, with no SEED_OUTPUT_FILE", () => {
    expect(() => assertSafeToSeed(DB_URL("invai"), DB_URL("invai_p6_reset"), undefined)).toThrow(
      /refusing: seeding invai_p6_reset would overwrite the shared seed-output\.json/,
    );
  });

  it("allows a mixed env when SEED_OUTPUT_FILE is set", () => {
    expect(() =>
      assertSafeToSeed(DB_URL("invai_p6_reset"), DB_URL("invai"), "/tmp/p6-1-seed-output.json"),
    ).not.toThrow();
  });
});
