import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../../env";
import { createCompany, createConnection, createOrder, truncateAll } from "../../../test/fixtures";
import { withSystem, withTenant } from "../../client";
import { members, users } from "../../schema";
import { PRINT_SIZES } from "../data";
import { SCALE_PROFILES } from "./profiles";
import { countAllTables } from "./row-counts";
import { ReplayError, type ScaleSeedReport, seedScaleProfile } from "./seed";

/*
 * T-54-3 acceptance on a real database (the harness's private test DB): the small profile is
 * seeded for real through the production seeding code, then AC2-AC6, AC9 and AC10 are read back
 * from the rows. AC8 runs the real CLI (`index.ts`) in a subprocess with a hand-made environment
 * (never the process env) and proves each refusal leaves every table in the target unchanged.
 */
const run = promisify(execFile);
const profile = SCALE_PROFILES.small;
const NOW = Date.now();
const DAY = 86_400_000;

const rows = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
  (await withSystem((tx) => tx.execute(q))).rows as T[];
const num = async (q: ReturnType<typeof sql>): Promise<number> =>
  Number(((await rows<{ n: string }>(q))[0] as { n: string }).n);

/** company_id tables with their row count for one company. */
async function tenantCounts(companyId: string): Promise<Record<string, number>> {
  const tables = await rows<{ table_name: string }>(
    sql`select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'company_id' order by table_name`,
  );
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    out[table_name] = await num(
      sql`select count(*) as n from ${sql.identifier(table_name)} where company_id = ${companyId}`,
    );
  }
  return out;
}

let report: ScaleSeedReport;
let companyId: string;
let other: { id: string };
let otherBefore: Record<string, number>;
let otherAfter: Record<string, number>;
let seedBefore: number;

async function createLogin(email: string, name: string) {
  const [u] = await withSystem((tx) =>
    tx.insert(users).values({ email, name, emailVerified: true }).returning({ id: users.id }),
  );
  return (u as { id: string }).id;
}

beforeAll(async () => {
  await truncateAll();
  // "Desert Bloom already seeded": another shop with real rows in the same database.
  other = await createCompany({ name: "Already Seeded Shop" });
  const conn = await createConnection(other.id, "etsy");
  await createOrder(other.id, conn.id, { units: 2 });
  otherBefore = await tenantCounts(other.id);
  seedBefore = await num(sql`select count(*) as n from companies`);
  report = await seedScaleProfile(profile, {
    run: (fn, id) => withSystem(fn, id),
    createUser: createLogin,
    now: NOW,
  });
  companyId = report.companyId;
  otherAfter = await tenantCounts(other.id);
}, 180_000);

afterAll(async () => {
  await truncateAll();
});

describe("small profile, seeded for real", () => {
  it("AC2: orders per day, history days, stations and vendors are within 20%", async () => {
    const orders = await num(sql`select count(*) as n from orders where company_id = ${companyId}`);
    expect(orders / profile.historyDays).toBeGreaterThan(profile.ordersPerDay * 0.8);
    expect(orders / profile.historyDays).toBeLessThan(profile.ordersPerDay * 1.2);
    const oldest = await rows<{ t: Date }>(
      sql`select min(placed_at) as t from orders where company_id = ${companyId}`,
    );
    const days = (NOW - new Date((oldest[0] as { t: Date }).t).getTime()) / DAY;
    expect(days).toBeGreaterThan(profile.historyDays * 0.8);
    expect(days).toBeLessThan(profile.historyDays * 1.2);
    expect(await num(sql`select count(*) as n from stations where company_id = ${companyId}`)).toBe(
      3,
    );
    expect(
      await num(sql`select count(*) as n from vendor_connections where company_id = ${companyId}`),
    ).toBe(1);
  });

  it("AC2: staff users per role equal the role-mix table exactly", async () => {
    const got = await rows<{ role: string; n: string }>(
      sql`select role, count(*) as n from members where organization_id = ${companyId} group by role`,
    );
    expect(Object.fromEntries(got.map((r) => [r.role, Number(r.n)]))).toEqual({
      owner: 1,
      office: 1,
      presser: 1,
    });
    const emails = await rows<{ email: string }>(
      sql`select u.email from users u join members m on m.user_id = u.id where m.organization_id = ${companyId} order by 1`,
    );
    expect(emails.map((e) => e.email)).toEqual([
      "office1@seed-scale-small.test",
      "owner1@seed-scale-small.test",
      "presser1@seed-scale-small.test",
    ]);
    expect(members).toBeDefined();
  });

  it("AC3: the other shop's rows are identical before and after, and the new company is its own", async () => {
    expect(otherAfter).toEqual(otherBefore);
    expect(companyId).not.toBe(other.id);
    expect(await num(sql`select count(*) as n from companies`)).toBe(seedBefore + 1);
    // every company_id row of the new company is its own, and nothing leaked into the other one
    const foreign = await num(
      sql`select count(*) as n from orders where company_id not in (${companyId}, ${other.id})`,
    );
    expect(foreign).toBe(0);
  });

  it("AC4: sent sheets reach the floor, cost money and average 0.80-0.95 utilization", async () => {
    const [s] = await rows<{ n: string; avg: number; nocost: string }>(
      sql`select count(*) as n, avg(utilization) as avg, count(*) filter (where cost_cents <= 0) as nocost
          from gang_sheets where company_id = ${companyId}
          and status in ('sent','acknowledged','printing','printed','shipped','received')`,
    );
    expect(Number((s as { n: string }).n)).toBeGreaterThanOrEqual(profile.floors.sentSheets);
    expect(Number((s as { nocost: string }).nocost)).toBe(0);
    expect((s as { avg: number }).avg).toBeGreaterThanOrEqual(0.8);
    expect((s as { avg: number }).avg).toBeLessThanOrEqual(0.95);
    const sizes = await rows<{ w: number; h: number }>(
      sql`select distinct width_in as w, height_in as h from transfers where company_id = ${companyId}`,
    );
    const table = new Set(Object.values(PRINT_SIZES).map((p) => `${p.widthIn}x${p.heightIn}`));
    for (const z of sizes) expect(table.has(`${z.w}x${z.h}`)).toBe(true);
  });

  it("AC5a: no order_items row is more than one unit; items per order match the mean", async () => {
    const bad = await num(
      sql`select count(*) as n from (
            select order_id, line_no, units_in_line, count(*) as c, count(distinct unit_no) as u
            from order_items where company_id = ${companyId}
            group by order_id, line_no, units_in_line
            having count(*) <> units_in_line or count(distinct unit_no) <> units_in_line) x`,
    );
    expect(bad).toBe(0);
    const [r] = await rows<{ i: string; o: string }>(
      sql`select (select count(*) from order_items where company_id = ${companyId}) as i,
                 (select count(*) from orders where company_id = ${companyId}) as o`,
    );
    const ratio = Number((r as { i: string }).i) / Number((r as { o: string }).o);
    expect(ratio).toBeGreaterThan(profile.meanItems * 0.8);
    expect(ratio).toBeLessThan(profile.meanItems * 1.2);
    const mismatch = await num(
      sql`select count(*) as n from orders o where o.company_id = ${companyId}
          and o.item_count <> (select count(*) from order_items i where i.order_id = o.id and i.company_id = o.company_id)`,
    );
    expect(mismatch).toBe(0);
  });

  it("AC5b: every money column in the schema is an integer", async () => {
    const wrong = await rows<{ c: string }>(
      sql`select table_name || '.' || column_name as c from information_schema.columns
          where table_schema = 'public' and column_name like '%\_cents' and data_type not in ('integer','bigint','smallint')`,
    );
    expect(wrong).toEqual([]);
  });

  it("AC6: no outbox row exists for the new company", async () => {
    expect(
      await num(sql`select count(*) as n from outbox_events where company_id = ${companyId}`),
    ).toBe(0);
    expect(
      await num(sql`select count(*) as n from buyer_pii where company_id = ${companyId}`),
    ).toBe(0);
  });

  it("AC7: distinct file keys across design, sheet and artwork columns stay at or under 50", async () => {
    const n = await num(
      sql`select count(*) as n from (
            select file_key as k from design_files where company_id = ${companyId}
            union select preview_key from design_files where company_id = ${companyId}
            union select png_key from gang_sheets where company_id = ${companyId}
            union select pdf_key from gang_sheets where company_id = ${companyId}
            union select preview_key from gang_sheets where company_id = ${companyId}
            union select artwork_key from order_items where company_id = ${companyId}
            union select artwork_preview_key from order_items where company_id = ${companyId}) x
          where k is not null`,
    );
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(50);
    expect(await num(sql`select count(*) as n from files where company_id = ${companyId}`)).toBe(0);
  });

  it("AC9: every tenant row carries the new company_id, and another company sees none of it", async () => {
    const mine = await tenantCounts(companyId);
    expect(mine.orders).toBeGreaterThan(1000);
    const total = Object.values(mine).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(10_000);
    for (const table of Object.keys(mine)) {
      const asOther = await withTenant(other.id, async (tx) => {
        const r = await tx.execute(
          sql`select count(*) as n from ${sql.identifier(table)} where company_id = ${companyId}`,
        );
        return Number((r.rows[0] as { n: string }).n);
      });
      expect(asOther, `${table} leaked to another tenant`).toBe(0);
    }
    const asOwn = await withTenant(companyId, async (tx) => {
      const r = await tx.execute(sql`select count(*) as n from orders`);
      return Number((r.rows[0] as { n: string }).n);
    });
    expect(asOwn).toBe(mine.orders);
  });

  it("AC10: a second run fails with a plain message, adds zero rows and no second company", async () => {
    const before = await countAllTables(env.MIGRATION_DATABASE_URL);
    await expect(
      seedScaleProfile(profile, {
        run: (fn, id) => withSystem(fn, id),
        createUser: createLogin,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ReplayError);
    await expect(
      seedScaleProfile(profile, {
        run: (fn, id) => withSystem(fn, id),
        createUser: createLogin,
        now: NOW,
      }),
    ).rejects.toThrow(/already exists/);
    expect(await countAllTables(env.MIGRATION_DATABASE_URL)).toEqual(before);
    expect(await num(sql`select count(*) as n from companies where slug = ${profile.slug}`)).toBe(
      1,
    );
  });
});

describe("AC8: the real CLI refuses before it writes anything", () => {
  const tsx = `${process.cwd()}/node_modules/.bin/tsx`;
  const entry = "src/db/seed/scale/index.ts";
  const scratch = (name: string) =>
    env.MIGRATION_DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  const appScratch = (name: string) => env.DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  const GOOD = {
    DATABASE_URL: env.DATABASE_URL,
    MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL,
    REDIS_URL: "redis://localhost:6379/10",
    SEED_OUTPUT_FILE: "/tmp/invai-w54-T-54-3/cli-test-out.json",
  };

  /** Runs the CLI with a hand-made env (no inherited secrets, no .env) and returns code + stderr. */
  async function cli(over: Record<string, string | undefined>) {
    const e: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      INVAI_SKIP_DOTENV: "1",
      NODE_ENV: "development",
      ...(Object.fromEntries(
        Object.entries({ ...GOOD, ...over }).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
    };
    try {
      await run(tsx, [entry, "--profile", "small"], {
        env: e,
        cwd: process.cwd(),
        timeout: 60_000,
      });
      return { code: 0, stderr: "" };
    } catch (err) {
      const x = err as { code?: number; stderr?: string };
      return { code: x.code ?? 1, stderr: x.stderr ?? "" };
    }
  }

  const cases: [string, Record<string, string | undefined>, RegExp][] = [
    [
      "dev database invai in DATABASE_URL",
      { DATABASE_URL: appScratch("invai") },
      /DATABASE_URL names database "invai"/,
    ],
    [
      "dev database invai in MIGRATION_DATABASE_URL",
      { MIGRATION_DATABASE_URL: scratch("invai") },
      /MIGRATION_DATABASE_URL names database "invai"/,
    ],
    ["a test database name", {}, /not a scratch database/],
    ["Valkey 0", { REDIS_URL: "redis://localhost:6379/0" }, /Valkey database 0 is not allowed/],
    ["Valkey 9", { REDIS_URL: "redis://localhost:6379/9" }, /Valkey database 9 is not allowed/],
    ["Valkey 14", { REDIS_URL: "redis://localhost:6379/14" }, /Valkey database 14 is not allowed/],
    ["Valkey 15", { REDIS_URL: "redis://localhost:6379/15" }, /Valkey database 15 is not allowed/],
    [
      "a Valkey URL with no database index",
      { REDIS_URL: "redis://localhost:6379" },
      /REDIS_URL must end with the Valkey database/,
    ],
    ["a blank SEED_OUTPUT_FILE", { SEED_OUTPUT_FILE: "  " }, /SEED_OUTPUT_FILE/],
  ];

  it.each(cases)(
    "%s: exits non-zero with a plain message and adds zero rows",
    async (_label, over, message) => {
      // The target stays the harness database, whose name is not a scratch name either: a refusal
      // for the *other* reason must come from the rule under test, so scratch-name the good half.
      const named = {
        DATABASE_URL: appScratch("invai_scale_w54_refusal"),
        MIGRATION_DATABASE_URL: scratch("invai_scale_w54_refusal"),
      };
      const before = await countAllTables(env.MIGRATION_DATABASE_URL);
      const r = await cli(_label === "a test database name" ? over : { ...named, ...over });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(message);
      expect(r.stderr).not.toContain("invai:invai");
      expect(await countAllTables(env.MIGRATION_DATABASE_URL)).toEqual(before);
    },
    90_000,
  );

  it("refuses when only one of the two database URLs is a scratch database", async () => {
    const before = await countAllTables(env.MIGRATION_DATABASE_URL);
    const a = await cli({ DATABASE_URL: appScratch("invai_scale_w54_refusal") });
    const b = await cli({ MIGRATION_DATABASE_URL: scratch("invai_scale_w54_refusal") });
    expect(a.code).not.toBe(0);
    expect(a.stderr).toMatch(/MIGRATION_DATABASE_URL/);
    expect(b.code).not.toBe(0);
    expect(b.stderr).toMatch(/DATABASE_URL names database/);
    expect(await countAllTables(env.MIGRATION_DATABASE_URL)).toEqual(before);
  }, 90_000);

  it("rejects an unknown or missing profile with a usage line", async () => {
    try {
      await run(tsx, [entry, "--profile", "huge"], {
        env: { PATH: process.env.PATH ?? "", INVAI_SKIP_DOTENV: "1" },
        cwd: process.cwd(),
      });
      expect.unreachable();
    } catch (err) {
      expect((err as { stderr: string }).stderr).toMatch(
        /usage: db:seed:scale --profile small\|mid\|large/,
      );
    }
  }, 60_000);

  it("the plain seed's entry point does not import the scale code", () => {
    const text = readFileSync("src/db/seed/index.ts", "utf8");
    expect(text).not.toMatch(/scale/);
  });
});
