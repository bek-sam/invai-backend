import { spawnSync } from "node:child_process";
import { eq, like } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createSeededEvalTenant } from "../../evals/assistant/seed";
import { createEvalTenant } from "../../evals/lib/fixtures";
import {
  assertEvalDatabase,
  assertEvalEnv,
  runInScratch,
  safeErrorText,
  scratchName,
} from "../../evals/lib/scratch-db";
import { withSystem } from "../db/client";
import { companies } from "../db/schema";
import { env } from "../env";
import { pidIsDead } from "../test/test-db";

/*
 * T-53-2 (B-460): `pnpm evals` runs on its own scratch database. These tests drive the same
 * `runInScratch` the launcher (`evals/run.ts`) calls, with the harness test databases as the "dev"
 * base and a no-op migration, so nothing here touches the dev database `invai`.
 */

const ownerUrl = env.MIGRATION_DATABASE_URL;
const appUrl = env.DATABASE_URL;
const base = { appUrl, migrationUrl: ownerUrl, migrate: async () => {} };
const admin = new Pool({
  connectionString: (() => {
    const u = new URL(ownerUrl);
    u.pathname = "/postgres";
    return u.toString();
  })(),
  max: 2,
});
// Every database this file creates carries this process's pid in its 14-digit stamp, so two runs
// against one Postgres server never share a name (14 digits: 2099 + pid padded to 8 + 2-digit n).
const stamp = (n: number) =>
  `2099${String(process.pid).padStart(8, "0")}${String(n).padStart(2, "0")}`;
const created = new Set<string>();
const track = (name: string) => {
  created.add(name);
  return name;
};
const nameFor = (n: number, pid = process.pid) => track(`invai_evals_${stamp(n)}_${pid}`);

async function exists(name: string): Promise<boolean> {
  const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [name]);
  return rowCount === 1;
}

afterAll(async () => {
  await admin.query("select 1"); // keep the pool alive until the last test finishes
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.end();
});

describe("assertEvalDatabase (AC3)", () => {
  it("accepts only invai_evals_<14 digits>_<pid>", () => {
    expect(() =>
      assertEvalDatabase(`postgres://u:p@h:5432/${scratchName(123, new Date())}`),
    ).not.toThrow();
    for (const bad of [
      "invai",
      "invai_test",
      "invai_test_123",
      "invai_scratch_probe_1",
      "invai_evals_2026_1",
      "invai_evals_20261014120000_x",
      "invai_evals_20261014120000_1_extra",
    ]) {
      expect(() => assertEvalDatabase(`postgres://u:p@h:5432/${bad}`), bad).toThrow(
        /refusing to run evals on/,
      );
    }
  });

  it("refuses a percent-encoded dev name and any forbidden raw URL name", () => {
    expect(() => assertEvalDatabase("postgres://u:p@h:5432/%69nvai")).toThrow(/refusing/);
    const n = scratchName(55, new Date());
    expect(() =>
      assertEvalDatabase(`postgres://u:p@h:5432/${n}`, [`postgres://u:p@h/${n}`]),
    ).toThrow(/refusing/);
  });

  it("assertEvalEnv checks both URLs", () => {
    const ok = `postgres://u:p@h:5432/${scratchName(1, new Date())}`;
    expect(() => assertEvalEnv(ok, ok)).not.toThrow();
    expect(() => assertEvalEnv("postgres://u:p@h:5432/invai", ok)).toThrow(/refusing/);
    expect(() => assertEvalEnv(ok, "postgres://u:p@h:5432/invai")).toThrow(/refusing/);
  });
});

describe("runInScratch", () => {
  it("creates the database for the body and drops it after a normal return", async () => {
    const name = nameFor(1);
    let during = false;
    const result = await runInScratch(
      async (ctx) => {
        during = await exists(ctx.name);
        expect(ctx.databaseUrl).toContain(name);
        expect(ctx.migrationDatabaseUrl).toContain(name);
        return 42;
      },
      { ...base, name },
    );
    expect(result).toBe(42);
    expect(during).toBe(true);
    expect(await exists(name)).toBe(false);
  });

  it("migrates before the body runs", async () => {
    const name = nameFor(2);
    const order: string[] = [];
    await runInScratch(async () => void order.push("body"), {
      ...base,
      name,
      migrate: async (url) => {
        order.push(`migrate:${new URL(url).pathname.slice(1)}`);
        expect(await exists(name)).toBe(true);
      },
    });
    expect(order).toEqual([`migrate:${name}`, "body"]);
  });

  it("drops the database when the body throws (AC2)", async () => {
    const name = nameFor(3);
    await expect(
      runInScratch(
        async () => {
          expect(await exists(name)).toBe(true);
          throw new Error("route blew up");
        },
        { ...base, name },
      ),
    ).rejects.toThrow("route blew up");
    expect(await exists(name)).toBe(false);
  });

  it("drops the database when the migration throws", async () => {
    const name = nameFor(4);
    await expect(
      runInScratch(async () => 1, {
        ...base,
        name,
        migrate: async () => {
          throw new Error("migration failed");
        },
      }),
    ).rejects.toThrow("migration failed");
    expect(await exists(name)).toBe(false);
  });

  it("refuses a non-evals name before any write: body not called, no database (AC3, launcher path)", async () => {
    let called = false;
    const probe = `invai_scratch_probe_${process.pid}`;
    for (const name of [probe, "invai", "invai_test"]) {
      await expect(
        runInScratch(
          async () => {
            called = true;
          },
          { ...base, name },
        ),
      ).rejects.toThrow(/refusing to run evals/);
      expect(await exists(name === "invai" ? "invai_never_created" : probe)).toBe(false);
    }
    expect(called).toBe(false);
  });

  it("refuses when the generated target equals a raw dev name", async () => {
    const name = nameFor(5);
    const devLike = `postgres://u:p@h:5432/${name}`;
    await expect(
      runInScratch(async () => 1, { ...base, name, appUrl: devLike, migrationUrl: ownerUrl }),
    ).rejects.toThrow(/refusing/);
  });

  it("an existing database of the same name fails instead of being reused", async () => {
    const name = nameFor(6);
    await admin.query(`CREATE DATABASE "${name}"`);
    try {
      await expect(runInScratch(async () => 1, { ...base, name })).rejects.toThrow(
        /already exists/,
      );
      expect(await exists(name)).toBe(true); // not ours, not dropped
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    }
  });

  it("sweeps dead, old scratch databases but keeps fresh, live and unmarked ones (A12)", async () => {
    const dead = 2_000_000_000;
    expect(pidIsDead(dead)).toBe(true);
    const old = Date.now() - 2 * 60 * 60 * 1000;
    const mk = async (name: string, marker: string | null) => {
      await admin.query(`CREATE DATABASE "${name}"`);
      if (marker) await admin.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
    };
    const staleDead = track(`invai_evals_${stamp(1)}_${dead}`);
    const freshDead = track(`invai_evals_${stamp(2)}_${dead}`);
    const oldLive = track(`invai_evals_${stamp(3)}_${process.pid}`);
    const unmarked = track(`invai_evals_${stamp(4)}_${dead}`);
    await mk(staleDead, `created_at:${old}`);
    await mk(freshDead, `created_at:${Date.now()}`);
    await mk(oldLive, `created_at:${old}`);
    await mk(unmarked, null);
    await runInScratch(async () => 1, { ...base, name: nameFor(7) });
    expect(await exists(staleDead)).toBe(false);
    expect(await exists(freshDead)).toBe(true);
    expect(await exists(oldLive)).toBe(true);
    expect(await exists(unmarked)).toBe(true);
  });
});

describe("eval tenant setup leaves no company behind (AC4)", () => {
  it("createSeededEvalTenant: a failure after the first insert deletes the company", async () => {
    const now = new Date("2031-05-05T05:05:05.123Z");
    await expect(createSeededEvalTenant(now, { failForTest: true })).rejects.toThrow(/failForTest/);
    const rows = await withSystem((tx) =>
      tx
        .select()
        .from(companies)
        .where(eq(companies.name, `Eval analyst ${now.toISOString()}`)),
    );
    expect(rows).toHaveLength(0);
  });

  it("createEvalTenant: a failure after the user insert deletes the company", async () => {
    const name = `Eval harness failcase ${process.pid}`;
    await expect(createEvalTenant({ failForTest: true, name })).rejects.toThrow(/failForTest/);
    const rows = await withSystem((tx) =>
      tx.select().from(companies).where(like(companies.name, name)),
    );
    expect(rows).toHaveLength(0);
  });

  it("the happy path still creates the company", async () => {
    const now = new Date("2031-06-06T06:06:06.123Z");
    const t = await createSeededEvalTenant(now);
    const rows = await withSystem((tx) =>
      tx.select().from(companies).where(eq(companies.id, t.companyId)),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("the launcher never prints a connection URL or password (T-53-2 r2)", () => {
  const MARK = "PwMarker9z";
  const bad = `postgres://owner:${MARK}@db.example.test:notaport/invai`;

  it("safeErrorText drops the URL parser's input, URL spans and the env passwords", () => {
    let thrown: unknown;
    try {
      new URL(bad);
    } catch (e) {
      thrown = e;
    }
    expect(JSON.stringify(Object.getOwnPropertyNames(thrown))).toContain("input"); // why err is never printed
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = bad;
    try {
      const out = safeErrorText(new Error(`connect failed for ${bad} and again ${MARK}`));
      expect(out).not.toContain(MARK);
      expect(out).not.toContain("db.example.test");
      expect(safeErrorText(thrown)).not.toContain(MARK);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  for (const entry of ["evals/run.ts", "evals/market/main.ts"]) {
    it(`${entry} with a malformed password URL prints no marker (stdout + stderr)`, () => {
      const r = spawnSync("./node_modules/.bin/tsx", [entry], {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          INVAI_SKIP_DOTENV: "1",
          DATABASE_URL: bad,
          MIGRATION_DATABASE_URL: bad,
          REDIS_URL: `redis://:${MARK}@localhost:notaport/0`,
        },
      });
      const all = `${r.stdout}${r.stderr}`;
      expect(r.status).toBe(1);
      expect(all).toContain("evals failed:");
      expect(all).not.toContain(MARK);
      expect(all).not.toContain("db.example.test");
    });
  }
});
