import { beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/db/client";
import { main, runReport } from "./run";
import { SqlGuardError } from "./sql-guard";
import { makeShop } from "./testkit";

/*
 * The runner refuses a file with a call that is not on the allow-list before it opens a
 * transaction (wave 57 T-57-1, AC1, architect A1.6). One query file is swapped for planted text
 * at the file read, so the refusal comes from the real runReport and main.
 */

const planted = vi.hoisted(() => ({ text: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: ((path: unknown, ...rest: unknown[]) =>
      planted.text !== null && String(path).endsWith("film_waste_cost.sql")
        ? planted.text
        : (fs.readFileSync as (...a: unknown[]) => unknown)(
            path,
            ...rest,
          )) as typeof fs.readFileSync,
  };
});

vi.mock("../../src/db/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/db/client")>();
  return {
    ...mod,
    withTenantReadOnly: vi.fn(mod.withTenantReadOnly),
    closeDb: vi.fn(async () => undefined),
  };
});

const WINDOW = { from: "2026-05-04", to: "2026-06-04" };

describe("runner refusal before any transaction (AC1)", () => {
  beforeEach(() => {
    planted.text = null;
    vi.mocked(client.withTenantReadOnly).mockClear();
    vi.mocked(client.closeDb).mockClear();
  });

  it("runs the clean files: one transaction", async () => {
    const shop = await makeShop("Europe/Madrid");
    const report = await runReport({
      slug: shop.slug,
      ...WINDOW,
      queries: ["late_rate", "film_use"],
    });
    expect(Object.keys(report.queries)).toEqual(["late_rate", "film_use"]);
    expect(client.withTenantReadOnly).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a plain ts_stat", "select * from ts_stat('select 1')", /ts_stat/],
    [
      "a schema-qualified call",
      "select pg_catalog.ts_stat('select 1')",
      /qualified call ts_stat\(/,
    ],
    ["attribute notation", "select ('select 1'::text).ts_stat", /attribute notation/],
    ["a dollar quote", "select $q$x$q$", /\$ outside quotes/],
  ])("runReport rejects %s and never opens a transaction", async (_n, text, re) => {
    const shop = await makeShop("Europe/Madrid");
    planted.text = text;
    // the planted file is the second of two: the first, clean one must not run either
    const run = runReport({ slug: shop.slug, ...WINDOW, queries: ["late_rate", "film_use"] });
    await expect(run).rejects.toBeInstanceOf(SqlGuardError);
    await expect(run).rejects.toThrow(re);
    expect(client.withTenantReadOnly).not.toHaveBeenCalled();
  });

  it("main prints one fixed line that names the function and offset, exits 1, prints no report", async () => {
    const shop = await makeShop("Europe/Madrid");
    planted.text = "select * from ts_stat('select 1')";
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = await main(["--company", shop.slug, "--from", WINDOW.from, "--to", WINDOW.to]);
      expect(code).toBe(1);
      expect(err.mock.calls).toEqual([
        [
          "analytics: query refused by the SQL guard: function ts_stat is not on the allow-list (offset 14)",
        ],
      ]);
      expect(log).not.toHaveBeenCalled();
      expect(client.withTenantReadOnly).not.toHaveBeenCalled();
      expect(client.closeDb).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });
});
