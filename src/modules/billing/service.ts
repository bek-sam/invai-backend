import type { BillingStatus, Plan, PlanKey } from "@invai/contracts";
import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { type Tx, withSystem } from "../../db/client";
import {
  aiCreditLedger,
  channelConnections,
  companies,
  labels,
  members,
  orders,
  plans,
  subscriptions,
  usage,
} from "../../db/schema";
import { env } from "../../env";
import { audit } from "../../lib/audit";
import { badRequest, planLimit } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";

const log = logger("billing");

/*
 * Billing: the plan catalog, usage meters and plan-limit enforcement. Stripe is stubbed
 * (`env.mocks.billing`): changePlan records the new plan immediately and returns no checkout URL.
 */

type PlanRow = typeof plans.$inferSelect;

/** The v1 price list. Scale is custom (no order cap). Synced into the global `plans` table. */
export const PLAN_CATALOG: (typeof plans.$inferInsert)[] = [
  {
    key: "trial",
    name: "Trial",
    priceMonthlyCents: 0,
    ordersPerMonth: 300,
    aiCreditsPerMonth: 100,
    labelFeeCents: 0,
    maxUsers: 3,
    maxConnections: 2,
  },
  {
    key: "starter",
    name: "Starter",
    priceMonthlyCents: 14900,
    ordersPerMonth: 3000,
    aiCreditsPerMonth: 500,
    labelFeeCents: 5,
    maxUsers: 5,
    maxConnections: 4,
  },
  {
    key: "growth",
    name: "Growth",
    priceMonthlyCents: 34900,
    ordersPerMonth: 10000,
    aiCreditsPerMonth: 2000,
    labelFeeCents: 4,
    maxUsers: 15,
    maxConnections: 8,
  },
  {
    key: "pro",
    name: "Pro",
    priceMonthlyCents: 69900,
    ordersPerMonth: 30000,
    aiCreditsPerMonth: 6000,
    labelFeeCents: 3,
    maxUsers: 40,
    maxConnections: 16,
  },
  {
    key: "scale",
    name: "Scale",
    priceMonthlyCents: 0,
    ordersPerMonth: null,
    aiCreditsPerMonth: 20000,
    labelFeeCents: 2,
    maxUsers: null,
    maxConnections: null,
  },
];

let catalogSynced: Promise<void> | null = null;

/** Upsert the catalog once per process (plans is a global table: owner connection). */
export function ensurePlanCatalog(): Promise<void> {
  catalogSynced ??= withSystem(async (tx) => {
    for (const p of PLAN_CATALOG) {
      await tx
        .insert(plans)
        .values(p)
        .onConflictDoUpdate({
          target: plans.key,
          set: {
            name: p.name,
            priceMonthlyCents: p.priceMonthlyCents,
            ordersPerMonth: p.ordersPerMonth,
            aiCreditsPerMonth: p.aiCreditsPerMonth,
            labelFeeCents: p.labelFeeCents,
            maxUsers: p.maxUsers,
            maxConnections: p.maxConnections,
            updatedAt: new Date(),
          },
        });
    }
  }).catch((err) => {
    catalogSynced = null;
    log.error("plan catalog sync failed", { error: (err as Error).message });
  });
  return catalogSynced;
}

function toPlan(row: PlanRow): Plan {
  return {
    key: row.key,
    name: row.name,
    priceMonthly: row.priceMonthlyCents,
    ordersPerMonth: row.ordersPerMonth,
    aiCreditsPerMonth: row.aiCreditsPerMonth,
    labelFee: row.labelFeeCents,
    maxUsers: row.maxUsers,
    maxConnections: row.maxConnections,
  };
}

export async function listPlans(tx: Tx): Promise<{ items: Plan[] }> {
  await ensurePlanCatalog();
  const rows = await tx.select().from(plans).orderBy(plans.priceMonthlyCents);
  const order = PLAN_CATALOG.map((p) => p.key);
  rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { items: rows.map(toPlan) };
}

/** Calendar-month usage period (UTC) containing `at`. */
export function periodOf(at = new Date()) {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end, key: start.toISOString().slice(0, 7) };
}

/** The company's current plan (falls back to the catalog when the table is not synced yet). */
export async function getPlan(tx: Tx, companyId: string): Promise<Plan> {
  await ensurePlanCatalog();
  const [company] = await tx
    .select({ plan: companies.plan })
    .from(companies)
    .where(eq(companies.id, companyId));
  const key = (company?.plan ?? "trial") as PlanKey;
  const [row] = await tx.select().from(plans).where(eq(plans.key, key));
  if (row) return toPlan(row);
  const fallback = PLAN_CATALOG.find((p) => p.key === key) ?? PLAN_CATALOG[0];
  return toPlan({ ...fallback, createdAt: new Date(), updatedAt: new Date() } as PlanRow);
}

type Meter = BillingStatus["usage"]["orders"];

function meter(used: number, limit: number | null): Meter {
  return {
    used,
    limit,
    ratio: limit ? used / limit : null,
    limitReached: limit != null && used >= limit,
  };
}

async function count(tx: Tx, q: Promise<{ n: number }[]>) {
  const [row] = await q;
  return row?.n ?? 0;
}

/** Raw meter values for the current period. */
export async function currentUsage(tx: Tx, companyId: string, at = new Date()) {
  const p = periodOf(at);
  const n = sql<number>`count(*)::int`;
  const ordersUsed = await count(
    tx,
    tx
      .select({ n })
      .from(orders)
      .where(
        and(
          eq(orders.companyId, companyId),
          gte(orders.createdAt, p.start),
          lt(orders.createdAt, p.end),
        ),
      ),
  );
  const users = await count(
    tx,
    tx
      .select({ n })
      .from(members)
      .where(and(eq(members.organizationId, companyId), eq(members.status, "active"))),
  );
  const connections = await count(
    tx,
    tx
      .select({ n })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.companyId, companyId),
          ne(channelConnections.status, "disconnected"),
        ),
      ),
  );
  const [ledger] = await tx
    .select({ used: sql<number>`coalesce(-sum(${aiCreditLedger.credits}), 0)::int` })
    .from(aiCreditLedger)
    .where(
      and(
        eq(aiCreditLedger.companyId, companyId),
        eq(aiCreditLedger.period, p.key),
        sql`${aiCreditLedger.credits} < 0`,
      ),
    );
  const [meterRow] = await tx
    .select()
    .from(usage)
    .where(and(eq(usage.companyId, companyId), eq(usage.period, p.key)));
  const [labelRow] = await tx
    .select({
      n: sql<number>`count(*)::int`,
      fees: sql<number>`coalesce(sum(${labels.labelFeeCents}), 0)::int`,
    })
    .from(labels)
    .where(
      and(
        eq(labels.companyId, companyId),
        inArray(labels.status, ["purchased"]),
        gte(labels.purchasedAt, p.start),
        lt(labels.purchasedAt, p.end),
      ),
    );
  return {
    period: p,
    orders: Math.max(ordersUsed, meterRow?.ordersImported ?? 0),
    aiCredits: Math.max(ledger?.used ?? 0, meterRow?.aiCredits ?? 0),
    users,
    connections,
    labelsBought: Math.max(labelRow?.n ?? 0, meterRow?.labelsBought ?? 0),
    labelFees: Math.max(labelRow?.fees ?? 0, meterRow?.labelFeesCents ?? 0),
  };
}

async function subscriptionOf(tx: Tx, companyId: string) {
  const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.companyId, companyId));
  return row ?? null;
}

export async function getStatus(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId">,
): Promise<BillingStatus> {
  const plan = await getPlan(tx, ctx.companyId);
  const u = await currentUsage(tx, ctx.companyId);
  const sub = await subscriptionOf(tx, ctx.companyId);
  return {
    plan,
    usage: {
      periodStart: u.period.start.toISOString(),
      periodEnd: u.period.end.toISOString(),
      orders: meter(u.orders, plan.ordersPerMonth),
      aiCredits: meter(u.aiCredits, plan.aiCreditsPerMonth),
      users: meter(u.users, plan.maxUsers),
      connections: meter(u.connections, plan.maxConnections),
      labelsBought: u.labelsBought,
      labelFees: u.labelFees,
    },
    status: sub?.status ?? "trialing",
    trialEndsAt: sub?.trialEndsAt?.toISOString() ?? null,
    paymentsEnabled: !env.mocks.billing,
    overLimitBehavior: sub?.overLimitBehavior ?? "warn",
  };
}

export async function changePlan(tx: Tx, ctx: TenantContext, key: PlanKey) {
  if (ctx.orgType !== "shop") throw badRequest("Vendor organizations have no plan");
  const plans_ = await listPlans(tx);
  const target = plans_.items.find((p) => p.key === key);
  if (!target) throw badRequest(`Unknown plan ${key}`);
  const before = await getPlan(tx, ctx.companyId);
  await tx.update(companies).set({ plan: key }).where(eq(companies.id, ctx.companyId));
  const now = new Date();
  const status = key === "trial" ? ("trialing" as const) : ("active" as const);
  await tx
    .insert(subscriptions)
    .values({
      companyId: ctx.companyId,
      planKey: key,
      status,
      currentPeriodStart: periodOf(now).start,
      currentPeriodEnd: periodOf(now).end,
    })
    .onConflictDoUpdate({
      target: subscriptions.companyId,
      set: { planKey: key, status, updatedAt: now },
    });
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "billing.change_plan",
    entityType: "company",
    entityId: ctx.companyId,
    summary: `${before.key} -> ${key}`,
    data: { from: before.key, to: key, stripe: env.mocks.billing ? "mock" : "live" },
  });
  await emit(tx, ctx.companyId, "plan.changed", { orgId: ctx.companyId, plan: key });
  // Stripe checkout is stubbed: no key means the change applies immediately.
  return { checkoutUrl: null, status: await getStatus(tx, ctx) };
}

export type PlanMeter = "orders" | "aiCredits" | "users" | "connections";

/**
 * Plan-limit enforcement. Call before creating `adding` more of `meter` (order import: one call
 * per import with the number of new orders). Throws PLAN_LIMIT_REACHED when the limit would be
 * exceeded — for `orders` only when the subscription's overLimitBehavior is `block_imports`; with
 * the default `warn` the import continues and a `plan.limit_reached` event is emitted.
 */
export async function assertWithinPlan(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId">,
  meterName: PlanMeter,
  adding = 1,
): Promise<{ used: number; limit: number | null; overLimit: boolean }> {
  const plan = await getPlan(tx, ctx.companyId);
  const limit = {
    orders: plan.ordersPerMonth,
    aiCredits: plan.aiCreditsPerMonth,
    users: plan.maxUsers,
    connections: plan.maxConnections,
  }[meterName];
  if (limit == null) return { used: 0, limit: null, overLimit: false };
  const u = await currentUsage(tx, ctx.companyId);
  const used = u[meterName];
  const overLimit = used + adding > limit;
  if (!overLimit) return { used, limit, overLimit };
  const sub = await subscriptionOf(tx, ctx.companyId);
  await emit(tx, ctx.companyId, "plan.limit_reached", {
    orgId: ctx.companyId,
    meter: meterName,
    used,
    limit,
  });
  if (meterName !== "orders" || sub?.overLimitBehavior === "block_imports") {
    throw planLimit(meterName, used, limit);
  }
  return { used, limit, overLimit };
}

/** Bump the monthly usage row (labels bought, sheets built...). Safe to call from any module. */
export async function recordUsage(
  tx: Tx,
  companyId: string,
  delta: Partial<{
    ordersImported: number;
    labelsBought: number;
    labelFeesCents: number;
    sheetsBuilt: number;
    aiCredits: number;
  }>,
) {
  const key = periodOf().key;
  const values = {
    ordersImported: delta.ordersImported ?? 0,
    labelsBought: delta.labelsBought ?? 0,
    labelFeesCents: delta.labelFeesCents ?? 0,
    sheetsBuilt: delta.sheetsBuilt ?? 0,
    aiCredits: delta.aiCredits ?? 0,
  };
  await tx
    .insert(usage)
    .values({ companyId, period: key, ...values })
    .onConflictDoUpdate({
      target: [usage.companyId, usage.period],
      set: {
        ordersImported: sql`${usage.ordersImported} + ${values.ordersImported}`,
        labelsBought: sql`${usage.labelsBought} + ${values.labelsBought}`,
        labelFeesCents: sql`${usage.labelFeesCents} + ${values.labelFeesCents}`,
        sheetsBuilt: sql`${usage.sheetsBuilt} + ${values.sheetsBuilt}`,
        aiCredits: sql`${usage.aiCredits} + ${values.aiCredits}`,
        updatedAt: new Date(),
      },
    });
}
