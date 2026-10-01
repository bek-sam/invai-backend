import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { auth } from "../../auth";
import { env } from "../../env";
import { logger } from "../../lib/log";
import { PLAN_CATALOG } from "../../modules/billing/service";
import { closeDb, systemDb, withSystem } from "../client";
import type { Role } from "../schema";
import { companies, members, plans, subscriptions, users } from "../schema";
import { buildShopData, DESERT_BLOOM_PROFILE, FULL_VOLUME } from "./builder";
import { rng } from "./data";
import { seedMarketDemand } from "./market-demand";
import { buildWeeklyDigest } from "./weekly-digest";

/*
 * Demo seed: "Desert Bloom Tees" (v1-plan 5.4). Runs as the owner role. Idempotent-ish: it
 * refuses to run twice (reset the database first). Orders go through the real state machine
 * so transitions, audit rows and outbox events are consistent with production behaviour.
 * The shop's data comes from the reusable builder (./builder.ts), which tenancy.demo also uses.
 *
 *   pnpm db:reset && pnpm db:migrate && pnpm db:seed
 */

const log = logger("seed");
const PASSWORD = "demo1234!";
const random = rng(20260924);
const DAY = 86_400_000;

type SeedUser = { email: string; name: string; role: Role; pin: string; locale?: "en" | "es" };

const SHOP_USERS: SeedUser[] = [
  { email: "owner@desertbloom.test", name: "Riley Owner", role: "owner", pin: "1111" },
  { email: "admin@desertbloom.test", name: "Alex Admin", role: "admin", pin: "1122" },
  { email: "office@desertbloom.test", name: "Olivia Office", role: "office", pin: "1133" },
  { email: "designer@desertbloom.test", name: "Dana Designer", role: "designer", pin: "1144" },
  { email: "presser@desertbloom.test", name: "Pat Presser", role: "presser", pin: "1155" },
  { email: "packer@desertbloom.test", name: "Paula Packer", role: "packer", pin: "1166" },
  { email: "receiver@desertbloom.test", name: "Ray Receiver", role: "receiver", pin: "1177" },
  // Spanish-speaking floor staff (T-13-5, B-111): locale: "es" so their floor UI comes up in Spanish.
  {
    email: "luis@desertbloom.test",
    name: "Luis Presser",
    role: "presser",
    pin: "1188",
    locale: "es",
  },
];

async function signUp(email: string, name: string): Promise<string> {
  const res = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
  await systemDb.update(users).set({ emailVerified: true }).where(eq(users.id, res.user.id));
  return res.user.id;
}

/**
 * B-219: seeding any database other than the shared dev/CI database `invai` must never overwrite
 * the shared `seed-output.json` that other agents and the station token depend on (2026-10-01
 * T-P5-1 overwrote it from a scratch seed). `invai` always writes `seed-output.json` as today,
 * whatever `SEED_OUTPUT_FILE` is. Checked before any insert so a refusal never comes after the
 * ~15-minute render-heavy seed has already run.
 */
export function assertSafeToSeed(
  migrationDatabaseUrl: string,
  seedOutputFile: string | undefined,
): void {
  const database = new URL(migrationDatabaseUrl).pathname.slice(1);
  if (database === "invai") return;
  if (!seedOutputFile?.trim()) {
    throw new Error(
      `[seed] refusing: seeding ${database} would overwrite the shared seed-output.json. ` +
        "Set SEED_OUTPUT_FILE=<path> for this database.",
    );
  }
}

async function seedGlobals() {
  // Trademark marks are no longer seeded here: `ensureReferenceData` (src/db/reference)
  // upserts them at the end of every `pnpm db:migrate`, which always runs before this script.
  await systemDb.insert(plans).values(PLAN_CATALOG).onConflictDoNothing();
  log.info("globals", { plans: 5 });
}

async function main() {
  const started = Date.now();
  assertSafeToSeed(env.MIGRATION_DATABASE_URL, process.env.SEED_OUTPUT_FILE);
  const [existing] = await systemDb
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.slug, "desert-bloom-tees"))
    .limit(1);
  if (existing) {
    log.warn("Desert Bloom Tees already exists; run `pnpm db:reset && pnpm db:migrate` first");
    return;
  }
  await seedGlobals();

  /* ---- companies and users ---- */
  const [shop] = await systemDb
    .insert(companies)
    .values({
      name: "Desert Bloom Tees",
      slug: "desert-bloom-tees",
      type: "shop",
      plan: "growth",
      timezone: "America/Phoenix",
      demo: true,
      // Etsy's validator requires one (production_partner_required, T-8-1); Desert Bloom's real
      // DTF vendor (seeded just below) is the natural value, not a made-up name.
      settings: { productionPartner: { name: "Sun City DTF", etsyPartnerId: null } },
    })
    .returning();
  const [vendorOrg] = await systemDb
    .insert(companies)
    .values({
      name: "Sun City DTF",
      slug: "sun-city-dtf",
      type: "vendor",
      plan: null,
      timezone: "America/Phoenix",
      demo: true,
    })
    .returning();
  if (!shop || !vendorOrg) throw new Error("company insert failed");
  const shopId = shop.id;

  const userIds = new Map<string, string>();
  for (const u of SHOP_USERS) {
    const id = await signUp(u.email, u.name);
    userIds.set(u.email, id);
    await systemDb
      .insert(members)
      .values({ organizationId: shopId, userId: id, role: u.role, status: "active" });
  }
  const vendorUserId = await signUp("vendor@suncitydtf.test", "Val Vendor");
  await systemDb.insert(members).values({
    organizationId: vendorOrg.id,
    userId: vendorUserId,
    role: "vendor",
    status: "active",
  });
  const ownerId = userIds.get("owner@desertbloom.test") as string;
  log.info("users", { shop: SHOP_USERS.length, vendor: 1 });

  await systemDb.insert(subscriptions).values({
    companyId: shopId,
    planKey: "growth",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 20 * DAY),
  });

  const { stationToken, channels } = await buildShopData({
    companyId: shopId,
    random,
    run: (fn) => withSystem(fn, shopId),
    runHistory: (fn) => withSystem(fn, shopId),
    profile: DESERT_BLOOM_PROFILE,
    people: {
      owner: ownerId,
      office: userIds.get("office@desertbloom.test") as string,
      presser: userIds.get("presser@desertbloom.test") as string,
      packer: userIds.get("packer@desertbloom.test") as string,
      receiver: userIds.get("receiver@desertbloom.test") as string,
    },
    pins: SHOP_USERS.map((u) => ({
      userId: userIds.get(u.email) as string,
      pin: u.pin,
      locale: u.locale,
    })),
    issueStationToken: true,
    vendor: {
      vendorCompanyId: vendorOrg.id,
      name: "Sun City DTF",
      email: "vendor@suncitydtf.test",
    },
    volume: FULL_VOLUME,
    render: { designs: true, artwork: true, sheets: true },
    // T-A1 (B-168): 18 months of closed order history for analytics, bulk-inserted (see
    // `buildShopData`'s "closed history" section). Full seed only.
    closedHistory: true,
    // B-208: real design QA before the outbox is released (settled hand-over).
    settleQa: true,
  });

  // B-207: build this week's digest now, the same way the hourly sweep would once the shop's
  // local clock reaches its send slot, so a fresh seed already has one (gate digest specs).
  const digest = await buildWeeklyDigest(shopId, shop.timezone);
  log.info("digest", digest);

  // T-23-10: refresh the global demand cache and compute this shop's market signals now, the
  // way the hourly market sweep would (`src/db/seed/market-demand.ts`), so `market.spec.ts`'s
  // "Sample data" badge has outside demand data to show right after a fresh seed.
  const market = await seedMarketDemand(shopId);
  log.info("market", { demand: market.demand.sources.length, ...market.signals });

  const [counts] = await systemDb
    .select({
      orders: sql<number>`(select count(*) from orders where company_id = ${shopId})`.mapWith(
        Number,
      ),
      items: sql<number>`(select count(*) from order_items where company_id = ${shopId})`.mapWith(
        Number,
      ),
      transitions:
        sql<number>`(select count(*) from order_item_transitions where company_id = ${shopId})`.mapWith(
          Number,
        ),
      dueSoon:
        sql<number>`(select count(*) from orders where company_id = ${shopId} and status in ('new','needs_attention','in_production','ready_to_ship') and ship_by < now() + interval '2 days')`.mapWith(
          Number,
        ),
    })
    .from(sql`(select 1) as one`);

  const output = {
    shopId,
    vendorOrgId: vendorOrg.id,
    logins: {
      owner: "owner@desertbloom.test",
      vendor: "vendor@suncitydtf.test",
      password: PASSWORD,
    },
    pins: Object.fromEntries(SHOP_USERS.map((u) => [u.email, u.pin])),
    stationToken: { station: "Press 1", token: stationToken },
    channels,
    counts,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  // SEED_OUTPUT_FILE lets a seed of a DB copy write elsewhere, so it never clobbers the shared file.
  writeFileSync(
    process.env.SEED_OUTPUT_FILE || "seed-output.json",
    `${JSON.stringify(output, null, 2)}\n`,
  );
  log.info("done", { ...counts, seconds: output.seconds });
  console.log(
    `\nLogins: owner@desertbloom.test / ${PASSWORD} (all shop roles use the same password)\n        vendor@suncitydtf.test / ${PASSWORD}\nPINs:   ${SHOP_USERS.map((u) => `${u.role}=${u.pin}`).join(" ")}\nPress 1 station token (also in seed-output.json):\n        ${stationToken}\n`,
  );
}

// Guarded like src/db/reset.ts: only runs main() when this file is the script node/tsx was
// invoked with (`pnpm db:seed`), never as a side effect of another module importing
// `assertSafeToSeed` for a unit test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      const { closeQueues } = await import("../../lib/queues");
      await closeQueues().catch(() => {});
      await closeDb();
    });
}
