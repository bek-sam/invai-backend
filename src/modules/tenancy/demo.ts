import { type Me, ROLE_PERMISSIONS } from "@invai/contracts";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Context, Membership, TenantContext } from "../../api/context";
import { auth } from "../../auth";
import { db, withSystem, withTenant } from "../../db/client";
import type { CompanySettings } from "../../db/schema";
import { companies, members, users } from "../../db/schema";
import { buildShopData, DESERT_BLOOM_PROFILE } from "../../db/seed/builder";
import { rng } from "../../db/seed/data";
import { badRequest, forbidden } from "../../lib/errors";
import { errorData, logger } from "../../lib/log";
import { deleteObject, listKeysOlderThan } from "../../lib/s3";
import * as svc from "./service";

/*
 * tenancy.demo: a user's own sample-data workspace. One demo company per user, found by
 * `companies.demoOwnerUserId` whichever real company they start from. It is an ordinary
 * company (its rows are isolated by the same `company_id` RLS as any other), flagged
 * `demo = true`, so billing, email and marketplace calls leave it out (see isDemoCompany).
 *
 * The sample data comes from the seed's builder (db/seed/builder.ts) with smaller volumes, written
 * under `withTenant(demoId)`. Filling it takes a few seconds, so `start` runs it in the request
 * and returns the finished workspace (a small, bounded job: ~50 orders, no imaging renders of
 * artwork or sheets).
 */

const log = logger("demo");

/** Small enough to fill in a few seconds, big enough that every screen has something to show. */
export const DEMO_VOLUME = { historicalOrders: 36, dueSoonOrders: 12, adSpendDays: 14 };
const DEMO_RANDOM_SEED = 20260925;
const DEMO_NAMES = { en: "Sample shop", es: "Tienda de ejemplo" } as const;

type RequestContext = Context & { tenant: TenantContext };

function userIdOf(context: RequestContext): string {
  const userId = context.tenant.userId;
  if (context.sessionKind !== "user" || !userId)
    throw forbidden("org.read", "Sign in as a person to try the sample shop");
  return userId;
}

/** The caller's own demo company, if any. */
export async function findDemoCompany(userId: string) {
  const [row] = await db
    .select()
    .from(companies)
    .where(eq(companies.demoOwnerUserId, userId))
    .limit(1);
  return row ?? null;
}

async function createDemoCompany(userId: string) {
  const [user] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const name = user?.locale === "es" ? DEMO_NAMES.es : DEMO_NAMES.en;
  const id = crypto.randomUUID();
  const [created] = await db
    .insert(companies)
    .values({
      id,
      name,
      slug: `demo-${id}`,
      type: "shop",
      plan: "growth",
      timezone: "America/Phoenix",
      demo: true,
      demoOwnerUserId: userId,
    })
    .onConflictDoNothing()
    .returning();
  // A concurrent start already created it: use that one.
  const company = created ?? (await findDemoCompany(userId));
  if (!company) throw new Error("demo company insert failed");
  await db
    .insert(members)
    .values({ organizationId: company.id, userId, role: "owner", status: "active" })
    .onConflictDoNothing();
  return company;
}

/** Fill a new demo company with sample data. The whole company is removed if this fails. */
async function fillDemoCompany(companyId: string, userId: string) {
  const started = Date.now();
  try {
    await buildShopData({
      companyId,
      random: rng(DEMO_RANDOM_SEED),
      run: (fn) => withTenant(companyId, fn),
      // Written reason for withSystem in a request path: backdating the sample order timelines
      // rewrites `order_item_transitions`, which is append-only for the app role (migration
      // 0001). The statements are pinned to this company id and to the orders just built for
      // it; nothing else runs on the owner connection.
      runHistory: (fn) => withSystem(fn, companyId),
      profile: {
        ...DESERT_BLOOM_PROFILE,
        shopifyDomain: `sample-${companyId.slice(0, 8)}.myshopify.com`,
      },
      people: { owner: userId, office: userId, presser: userId, packer: userId, receiver: userId },
      pins: [],
      issueStationToken: false,
      // Email delivery to an address that can never be delivered: sample sheets reach no one.
      vendor: {
        vendorCompanyId: null,
        name: "Sample DTF Supply",
        email: "orders@sample-dtf.invalid",
      },
      volume: DEMO_VOLUME,
      render: { designs: true, artwork: false, sheets: false },
    });
    await db
      .update(companies)
      .set({
        settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('demoSeededAt', ${new Date().toISOString()}::text)`,
      })
      .where(eq(companies.id, companyId));
    log.info("demo filled", { companyId, ms: Date.now() - started });
  } catch (err) {
    log.error("demo fill failed", { companyId, ...errorData(err) });
    await retireDemoCompany(companyId);
    throw err;
  }
}

/**
 * Retire a demo company: unlink it from its user and remove every membership, so nobody can open
 * it again and the user's next demo starts fresh. The rows are kept, not deleted: the
 * `inventory_movements` append-only trigger refuses every DELETE (even the cascade from
 * `companies`), and weakening that control for sample data isn't worth it. A retired demo stays
 * `demo = true`, so it is still left out of billing, email and marketplace calls.
 */
async function retireDemoCompany(companyId: string) {
  await db.transaction(async (tx) => {
    await tx
      .update(companies)
      .set({ demoOwnerUserId: null })
      .where(and(eq(companies.id, companyId), eq(companies.demo, true)));
    await tx.delete(members).where(eq(members.organizationId, companyId));
  });
  // Sample design art lives under `{companyId}/`; best effort, a leftover is only storage.
  try {
    const keys = await listKeysOlderThan(`${companyId}/`, new Date(Date.now() + 60_000));
    for (const key of keys) await deleteObject(key);
  } catch (err) {
    log.warn("demo files cleanup failed", { companyId, ...errorData(err) });
  }
}

/** One fill at a time per user in this process (a double click must not seed twice). */
const inFlight = new Map<string, Promise<{ id: string }>>();

async function ensureFilledDemo(userId: string): Promise<{ id: string }> {
  const running = inFlight.get(userId);
  if (running) return running;
  const work = (async () => {
    const existing = await findDemoCompany(userId);
    if (existing && (existing.settings as CompanySettings).demoSeededAt) return existing;
    // Never finished filling (a crash mid-fill): start over with a new company.
    if (existing) await retireDemoCompany(existing.id);
    const company = await createDemoCompany(userId);
    await fillDemoCompany(company.id, userId);
    return company;
  })();
  inFlight.set(userId, work);
  try {
    return await work;
  } finally {
    inFlight.delete(userId);
  }
}

/** Make `companyId` the session's company and return `Me` for it (like me.switchOrg). */
async function switchTo(context: RequestContext, companyId: string): Promise<Me> {
  const userId = userIdOf(context);
  const rows = await db
    .select({
      orgId: members.organizationId,
      name: companies.name,
      type: companies.type,
      role: members.role,
    })
    .from(members)
    .innerJoin(companies, eq(companies.id, members.organizationId))
    .where(and(eq(members.userId, userId), eq(members.status, "active")))
    .orderBy(asc(members.createdAt));
  const memberships: Membership[] = rows;
  const target = memberships.find((m) => m.orgId === companyId);
  if (!target) throw forbidden("org.read", "Not a member of that company");
  await auth.api.setActiveOrganization({
    headers: context.headers,
    body: { organizationId: companyId },
  });
  const switched: RequestContext = {
    ...context,
    companyId,
    orgType: target.type,
    role: target.role,
    permissions: new Set(ROLE_PERMISSIONS[target.role]),
    memberships,
    tenant: { ...context.tenant, companyId, orgType: target.type, role: target.role },
  };
  return withTenant(companyId, (tx) => svc.me(tx, switched));
}

/** tenancy.demo.start: find or create (and fill) the caller's sample shop, and switch into it. */
export async function startDemo(context: RequestContext): Promise<Me> {
  const userId = userIdOf(context);
  if (context.tenant.orgType === "vendor")
    throw badRequest("The sample shop is for shops. Switch to your shop first.");
  const company = await ensureFilledDemo(userId);
  return switchTo(context, company.id);
}

/** tenancy.demo.reset: throw the caller's sample shop away and build a fresh one. */
export async function resetDemo(context: RequestContext): Promise<Me> {
  const userId = userIdOf(context);
  if (context.tenant.orgType === "vendor")
    throw badRequest("The sample shop is for shops. Switch to your shop first.");
  const existing = await findDemoCompany(userId);
  if (existing && !inFlight.has(userId)) await retireDemoCompany(existing.id);
  const company = await ensureFilledDemo(userId);
  return switchTo(context, company.id);
}

/**
 * tenancy.demo.leave: back to the caller's first real company (the one they joined first that
 * isn't their own sample shop). The sample shop is kept for next time.
 */
export async function leaveDemo(context: RequestContext): Promise<Me> {
  const userId = userIdOf(context);
  const [home] = await db
    .select({ id: companies.id })
    .from(members)
    .innerJoin(companies, eq(companies.id, members.organizationId))
    .where(
      and(
        eq(members.userId, userId),
        eq(members.status, "active"),
        isNull(companies.demoOwnerUserId),
      ),
    )
    .orderBy(asc(members.createdAt))
    .limit(1);
  if (!home) throw badRequest("You have no other company to go back to");
  return switchTo(context, home.id);
}
