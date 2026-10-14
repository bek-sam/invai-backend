import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../../env";
import { decryptField, sha256Hex } from "../../../lib/crypto";
import { hashPin, pinLogin } from "../../../modules/tenancy/floor-auth";
import { createCompany, createConnection, createOrder, truncateAll } from "../../../test/fixtures";
import { withSystem, withTenant } from "../../client";
import { members, users } from "../../schema";
import { PRINT_SIZES } from "../data";
import { SCALE_PROFILES } from "./profiles";
import { countAllTables } from "./row-counts";
import { ReplayError, type ScaleSeedReport, seedScaleProfile, writeReport } from "./seed";

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
    // the member rows themselves: three active members of this company, one per login
    const rowsOf = await withSystem((tx) =>
      tx
        .select({ role: members.role, status: members.status, userId: members.userId })
        .from(members)
        .where(eq(members.organizationId, companyId)),
    );
    expect(rowsOf).toHaveLength(3);
    expect(rowsOf.every((m) => m.status === "active")).toBe(true);
    expect(new Set(rowsOf.map((m) => m.userId)).size).toBe(3);
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

describe("T-55-3 phase 1: floor logins, shipments and fake buyer data", () => {
  const DIR = "/tmp/invai-w55-T-55-3";
  const isOpen = "i.state in ('transfer_in','on_sheet','pressed')";

  it("AC1: one hashed PIN per presser/packer/receiver member (small: presser only), never plaintext", async () => {
    expect(report.floor.members.map((m) => m.role)).toEqual(["presser"]);
    const pins = await rows<{ pin_hash: string; user_id: string; active: boolean }>(
      sql`select pin_hash, user_id, active from staff_pins where company_id = ${companyId}`,
    );
    expect(pins).toHaveLength(1);
    const m = report.floor.members[0] as { pin: string; email: string };
    expect(m.pin).toMatch(/^\d{6}$/);
    expect(pins[0]?.pin_hash).toBe(hashPin(companyId, m.pin));
    expect(pins[0]?.pin_hash).not.toContain(m.pin);
    expect(pins[0]?.pin_hash).toMatch(/^[0-9a-f]{64}$/);
    const owner = await rows<{ email: string }>(
      sql`select u.email from users u where u.id = ${pins[0]?.user_id}`,
    );
    expect(owner[0]?.email).toBe(m.email);
  });

  it("AC1: one live token per station, stored as a hash with an 8-character prefix", async () => {
    expect(report.floor.stations).toHaveLength(3);
    const toks = await rows<{ station_id: string; token_hash: string; token_prefix: string }>(
      sql`select station_id, token_hash, token_prefix from station_tokens
          where company_id = ${companyId} and revoked_at is null`,
    );
    expect(toks).toHaveLength(3);
    for (const st of report.floor.stations) {
      const row = toks.find((t) => t.station_id === st.id);
      expect(row?.token_hash).toBe(sha256Hex(st.token));
      expect(st.token).toContain(companyId);
      expect(row?.token_prefix).toHaveLength(8);
    }
    expect(new Set(report.floor.stations.map((s) => s.token)).size).toBe(3);
  });

  it("AC5: the seeded station token and PIN sign in through pinLogin; a wrong PIN is refused", async () => {
    const press = report.floor.stations.find((s) => s.kind === "press") as { token: string };
    const m = report.floor.members[0] as { pin: string };
    const ok = await pinLogin({ stationToken: press.token, pin: m.pin, ip: null });
    expect(ok.user.role).toBe("presser");
    expect(ok.station.kind).toBe("press");
    const wrong = m.pin === "654321" ? "123456" : "654321";
    await expect(
      pinLogin({ stationToken: press.token, pin: wrong, ip: null }),
    ).rejects.toMatchObject({ code: "INVALID_PIN" });
  });

  it("AC1: the credentials file is mode 0600 and holds tokens, PINs and open-unit scan targets only", async () => {
    const file = `${DIR}/accept-${process.pid}.json`;
    writeReport(file, report);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const got = JSON.parse(readFileSync(file, "utf8")) as ScaleSeedReport;
    expect(got.floor.stations).toHaveLength(3);
    expect(got.floor.scanTargets.length).toBeGreaterThan(0);
    expect(new Set(got.floor.scanTargets).size).toBe(got.floor.scanTargets.length);
    const open = await rows<{ id: string }>(
      sql`select t.id from transfers t join order_items i on i.company_id = t.company_id and i.id = t.order_item_id
          where t.company_id = ${companyId} and not t.scrapped and ${sql.raw(isOpen)}`,
    );
    const openIds = new Set(open.map((r) => r.id));
    for (const t of got.floor.scanTargets) expect(openIds.has(t)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toMatch(/@example\.com/);
  });

  it("AC2: one shipment per order with a shipped or delivered unit, consistent with the units", async () => {
    const orphan = await num(
      sql`select count(*) as n from (
            select o.id from orders o where o.company_id = ${companyId}
            and exists (select 1 from order_items i where i.order_id = o.id and i.state in ('shipped','delivered'))
            and not exists (select 1 from shipments s where s.order_id = o.id)) x`,
    );
    expect(orphan).toBe(0);
    const extra = await num(
      sql`select count(*) as n from shipments s where s.company_id = ${companyId}
          and not exists (select 1 from order_items i where i.order_id = s.order_id and i.state in ('shipped','delivered'))`,
    );
    expect(extra).toBe(0);
    const total = await num(
      sql`select count(*) as n from shipments where company_id = ${companyId}`,
    );
    expect(total).toBeGreaterThan(500);
    // status delivered iff every shipped/delivered unit is delivered; units match exactly
    const wrong = await num(
      sql`select count(*) as n from shipments s where s.company_id = ${companyId} and (
            s.status <> case when (select bool_and(i.state = 'delivered') from order_items i
                                   where i.order_id = s.order_id and i.state in ('shipped','delivered'))
                             then 'delivered' else 'in_transit' end
            or (select array_agg(x order by x) from unnest(s.order_item_ids) x) is distinct from
               (select array_agg(i.id order by i.id) from order_items i
                where i.order_id = s.order_id and i.state in ('shipped','delivered')))`,
    );
    expect(wrong).toBe(0);
    const shape = await rows<{ n: string; d: string; u: string }>(
      sql`select count(*) filter (where carrier = 'usps' and service = 'GroundAdvantage'
                 and tracking_code like '9400 1000 0000 %' and carrier_shipment_id like 'shp_mock_%'
                 and label_key is null and label_format is null) as n,
                 count(*) filter (where (status = 'delivered') = (delivered_at is not null)) as d,
                 count(distinct tracking_code) as u
          from shipments where company_id = ${companyId}`,
    );
    expect(Number(shape[0]?.n)).toBe(total);
    expect(Number(shape[0]?.d)).toBe(total);
    expect(Number(shape[0]?.u)).toBe(total);
    expect(await num(sql`select count(*) as n from labels where company_id = ${companyId}`)).toBe(
      0,
    );
  });

  it("AC2: a shipment is created no later than its first shipped transition", async () => {
    const late = await num(
      sql`select count(*) as n from shipments s where s.company_id = ${companyId}
          and s.created_at > (select min(t.created_at) from order_item_transitions t
                              where t.order_id = s.order_id and t.to_state = 'shipped')`,
    );
    expect(late).toBe(0);
  });

  it("AC3: buyer data is encrypted at rest, fake, and kept only for open or recent orders", async () => {
    const pii = await rows<{
      name: string;
      email: string;
      phone: string;
      street1: string;
      purge_after: Date | null;
      delivered_at: Date | null;
    }>(
      sql`select p.name, p.email, p.phone, p.street1, p.purge_after, o.delivered_at
          from buyer_pii p join orders o on o.id = p.order_id and o.company_id = p.company_id
          where p.company_id = ${companyId}`,
    );
    expect(pii.length).toBeGreaterThan(100);
    for (const r of pii.slice(0, 300)) {
      for (const v of [r.name, r.email, r.phone, r.street1]) {
        expect(v).toMatch(/^[^:\s]+:[A-Za-z0-9+/=]{20,}$/);
      }
      expect(decryptField(r.email)).toMatch(/@example\.com$/);
      expect(decryptField(r.phone)).toMatch(/^602-555-01\d\d$/);
      expect(r.email).not.toContain("example.com");
    }
    // share: every undelivered order, delivered ones only inside 30 days; purge_after = +30 d
    const missing = await num(
      sql`select count(*) as n from orders o where o.company_id = ${companyId}
          and (o.delivered_at is null or o.delivered_at + interval '30 days' > ${new Date(NOW)})
          and not exists (select 1 from buyer_pii p where p.order_id = o.id)`,
    );
    expect(missing).toBe(0);
    const stale = await num(
      sql`select count(*) as n from buyer_pii p join orders o on o.id = p.order_id and o.company_id = p.company_id
          where p.company_id = ${companyId} and o.delivered_at is not null
          and o.delivered_at + interval '30 days' <= ${new Date(NOW)}`,
    );
    expect(stale).toBe(0);
    const purge = await num(
      sql`select count(*) as n from buyer_pii p join orders o on o.id = p.order_id and o.company_id = p.company_id
          where p.company_id = ${companyId}
          and (p.purge_after is distinct from (o.delivered_at + interval '30 days'))`,
    );
    expect(purge).toBe(0);
    expect(pii.some((r) => r.delivered_at === null)).toBe(true);
    expect(pii.some((r) => r.purge_after !== null)).toBe(true);
  });

  it("AC2: no files rows are written (no label or buyer object keys point at missing files)", async () => {
    expect(await num(sql`select count(*) as n from files where company_id = ${companyId}`)).toBe(0);
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
