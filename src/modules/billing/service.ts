import type { BillingStatus, Plan, PlanKey } from "@invai/contracts";
import { and, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { type Tx, withSystem, withTenant } from "../../db/client";
import {
  aiCreditLedger,
  channelConnections,
  companies,
  invitations,
  labels,
  members,
  orders,
  plans,
  subscriptions,
  usage,
} from "../../db/schema";
import { env } from "../../env";
import { billingProvider, packLookupKey, planLookupKey } from "../../integrations/billing";
import { audit } from "../../lib/audit";
import { badRequest, conflict, ORPCError, planLimit } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";

const log = logger("billing");

/*
 * Billing: the plan catalog, usage meters, plan-limit enforcement and Stripe.
 * - Live Stripe (STRIPE_SECRET_KEY set): `checkout` opens a Stripe Checkout session and the plan
 *   and status change only in the `/webhooks/stripe` handler (`stripe-events.ts`). `changePlan`
 *   only downgrades to free (cancel at period end); a paid plan answers PAYMENT_REQUIRED.
 * - Mock Stripe: `changePlan` applies the plan immediately (demos), `checkout` returns a local URL.
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

async function count(_tx: Tx, q: Promise<{ n: number }[]>) {
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

type SubscriptionRow = typeof subscriptions.$inferSelect;
export type SubscriptionStatus = SubscriptionRow["status"];

export async function subscriptionOf(tx: Tx, companyId: string) {
  const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.companyId, companyId));
  return row ?? null;
}

/** True when payments go through real Stripe (the plan then changes only by webhook). */
export function paymentsLive() {
  return billingProvider().kind === "live";
}

/**
 * The status to act on now. A trial past `trialEndsAt` with no paid subscription is
 * `trial_expired` even before the nightly `expireTrials` job has written it.
 */
export function effectiveStatus(
  sub: Pick<SubscriptionRow, "status" | "trialEndsAt" | "stripeSubscriptionId"> | null,
  now = new Date(),
): SubscriptionStatus {
  if (!sub) return "trialing";
  if (
    sub.status === "trialing" &&
    sub.trialEndsAt &&
    sub.trialEndsAt <= now &&
    !sub.stripeSubscriptionId
  )
    return "trial_expired";
  return sub.status;
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
    status: effectiveStatus(sub),
    trialEndsAt: sub?.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: sub?.stripeSubscriptionId
      ? (sub.currentPeriodEnd?.toISOString() ?? null)
      : null,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    paymentsEnabled: paymentsLive(),
    overLimitBehavior: sub?.overLimitBehavior ?? "warn",
  };
}

/** Contracts `PAYMENT_REQUIRED` (HTTP 402). */
export function paymentRequired(checkoutUrl: string | null, message = "This needs an active plan") {
  return new ORPCError("PAYMENT_REQUIRED", { status: 402, message, data: { checkoutUrl } });
}

async function companyType(tx: Tx, companyId: string) {
  const [row] = await tx
    .select({ type: companies.type })
    .from(companies)
    .where(eq(companies.id, companyId));
  return row?.type ?? "shop";
}

/**
 * Gate for actions that spend money or bring in new work: order imports and label buys. Throws
 * PAYMENT_REQUIRED when the shop's trial has expired without a subscription. Reading data and
 * moving orders already in the system through the floor are never gated. Vendors have no plan.
 */
export async function assertPaidActionAllowed(tx: Tx, ctx: Pick<TenantContext, "companyId">) {
  if ((await companyType(tx, ctx.companyId)) !== "shop") return;
  const sub = await subscriptionOf(tx, ctx.companyId);
  if (effectiveStatus(sub) === "trial_expired")
    throw paymentRequired(null, "Your free trial has ended. Choose a plan to keep going.");
}

/** Only a direct plan write: mock Stripe (demos), or a downgrade to free with no live subscription. */
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
    data: { from: before.key, to: key, stripe: "mock" },
  });
  await emit(tx, ctx.companyId, "plan.changed", { orgId: ctx.companyId, plan: key });
  return { checkoutUrl: null, status: await getStatus(tx, ctx) };
}

/** Plans Stripe sells. `trial` is the free plan; `scale` is priced by hand (contact sales). */
export const SELF_SERVE_PLANS = ["starter", "growth", "pro"] as const satisfies readonly PlanKey[];
type SelfServePlan = (typeof SELF_SERVE_PLANS)[number];

export function isSelfServePlan(key: string): key is SelfServePlan {
  return (SELF_SERVE_PLANS as readonly string[]).includes(key);
}

/** AI credit packs (one-time payments). The price lives on the Stripe price `invai_pack_<key>`. */
export const AI_CREDIT_PACKS = {
  credits_500: { credits: 500 },
  credits_2000: { credits: 2000 },
} as const;
export type PackKey = keyof typeof AI_CREDIT_PACKS;

export function isPackKey(key: string): key is PackKey {
  return Object.hasOwn(AI_CREDIT_PACKS, key);
}

/** A Stripe subscription that is (still) paying: a second checkout would double-bill. */
function hasLiveSubscription(sub: SubscriptionRow | null) {
  return !!sub?.stripeSubscriptionId && (sub.status === "active" || sub.status === "past_due");
}

function billingPageUrl(params: Record<string, string> = {}) {
  const url = new URL("/settings/billing", env.WEB_ORIGIN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function openCheckout(
  ctx: TenantContext,
  sub: SubscriptionRow | null,
  item: { plan: SelfServePlan } | { pack: PackKey },
) {
  const isPlan = "plan" in item;
  const metadata: Record<string, string> = isPlan
    ? { companyId: ctx.companyId, plan: item.plan }
    : { companyId: ctx.companyId, pack: item.pack };
  const res = await billingProvider().createCheckout({
    companyId: ctx.companyId,
    customerId: sub?.stripeCustomerId ?? null,
    mode: isPlan ? "subscription" : "payment",
    lookupKey: isPlan ? planLookupKey(item.plan) : packLookupKey(item.pack),
    metadata,
    successUrl: billingPageUrl({ checkout: "success" }),
    cancelUrl: billingPageUrl({ checkout: "cancel" }),
  });
  log.info("checkout session created", {
    companyId: ctx.companyId,
    sessionId: res.id,
    ...(isPlan ? { plan: item.plan } : { pack: item.pack }),
  });
  return res.url;
}

/**
 * `billing.checkout`: a Stripe Checkout session for a plan (subscription) or an AI credit pack
 * (one-time). Never changes the plan or the credit balance: only the webhook does, once Stripe
 * confirms payment. The Stripe call runs with no transaction open.
 */
export async function checkout(
  ctx: TenantContext,
  input: { plan: PlanKey } | { pack: string },
): Promise<{ url: string }> {
  if (ctx.orgType !== "shop") throw badRequest("Vendor organizations have no plan");
  let item: { plan: SelfServePlan } | { pack: PackKey };
  if ("plan" in input) {
    if (!isSelfServePlan(input.plan))
      throw badRequest(
        input.plan === "trial"
          ? "The free plan needs no checkout"
          : "The Scale plan is set up with our team; contact us",
      );
    item = { plan: input.plan };
  } else {
    if (!isPackKey(input.pack)) throw badRequest("Unknown credit pack");
    item = { pack: input.pack };
  }
  const sub = await withTenant(ctx.companyId, (tx) => subscriptionOf(tx, ctx.companyId));
  if ("plan" in item && hasLiveSubscription(sub))
    throw conflict("You already have a subscription. Use Manage billing to change it.");
  return { url: await openCheckout(ctx, sub, item) };
}

/** `billing.portal`: Stripe's customer portal (payment method, invoices, cancel). */
export async function portal(ctx: TenantContext): Promise<{ url: string }> {
  if (ctx.orgType !== "shop") throw badRequest("Vendor organizations have no plan");
  const provider = billingProvider();
  const sub = await withTenant(ctx.companyId, (tx) => subscriptionOf(tx, ctx.companyId));
  if (provider.kind === "live" && !sub?.stripeCustomerId)
    throw badRequest("There's no billing account yet. Choose a plan first.");
  return provider.createPortal({
    customerId: sub?.stripeCustomerId ?? "",
    returnUrl: billingPageUrl(),
  });
}

/**
 * `billing.changePlan`. Mock Stripe: applies the plan at once (demos). Live Stripe: only a
 * downgrade to free is allowed — a paying subscription is set to cancel at period end (the
 * webhook moves the plan when it ends); with no live subscription the plan drops to free now.
 * A paid plan answers PAYMENT_REQUIRED with a checkout URL.
 */
export async function requestPlanChange(ctx: TenantContext, key: PlanKey) {
  if (ctx.orgType !== "shop") throw badRequest("Vendor organizations have no plan");
  if (!paymentsLive()) return withTenant(ctx.companyId, (tx) => changePlan(tx, ctx, key));

  const sub = await withTenant(ctx.companyId, (tx) => subscriptionOf(tx, ctx.companyId));
  if (key !== "trial") {
    if (!isSelfServePlan(key) || hasLiveSubscription(sub))
      throw paymentRequired(null, "Change a paid plan through checkout or Manage billing");
    throw paymentRequired(await openCheckout(ctx, sub, { plan: key }));
  }

  if (hasLiveSubscription(sub) && sub?.stripeSubscriptionId) {
    await billingProvider().cancelAtPeriodEnd(sub.stripeSubscriptionId);
    return withTenant(ctx.companyId, async (tx) => {
      await tx
        .update(subscriptions)
        .set({ cancelAtPeriodEnd: true })
        .where(eq(subscriptions.companyId, ctx.companyId));
      await audit(tx, {
        companyId: ctx.companyId,
        actor: ctx.actor,
        action: "billing.cancel_at_period_end",
        entityType: "company",
        entityId: ctx.companyId,
        summary: "Subscription set to end at the close of the period",
        data: { stripe: "live" },
      });
      return { checkoutUrl: null, status: await getStatus(tx, ctx) };
    });
  }

  // No paying subscription: drop to free now. The trial is not restarted.
  return withTenant(ctx.companyId, async (tx) => {
    const before = await getPlan(tx, ctx.companyId);
    if (before.key !== "trial") {
      await tx.update(companies).set({ plan: "trial" }).where(eq(companies.id, ctx.companyId));
      await tx
        .update(subscriptions)
        .set({
          planKey: "trial",
          status: sql`case when ${subscriptions.status} = 'active' then 'cancelled' else ${subscriptions.status} end`,
        })
        .where(eq(subscriptions.companyId, ctx.companyId));
      await audit(tx, {
        companyId: ctx.companyId,
        actor: ctx.actor,
        action: "billing.change_plan",
        entityType: "company",
        entityId: ctx.companyId,
        summary: `${before.key} -> trial`,
        data: { from: before.key, to: "trial", stripe: "live" },
      });
      await emit(tx, ctx.companyId, "plan.changed", { orgId: ctx.companyId, plan: "trial" });
    }
    return { checkoutUrl: null, status: await getStatus(tx, ctx) };
  });
}

export type PlanMeter = "orders" | "aiCredits" | "users" | "connections";

/** Active members plus pending, unexpired invitations: an invite holds a seat. */
async function seatsInUse(tx: Tx, companyId: string, exceptInviteEmail?: string) {
  const n = sql<number>`count(*)::int`;
  const [active] = await tx
    .select({ n })
    .from(members)
    .where(and(eq(members.organizationId, companyId), eq(members.status, "active")));
  const [pending] = await tx
    .select({ n })
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, companyId),
        eq(invitations.status, "pending"),
        or(isNull(invitations.expiresAt), gt(invitations.expiresAt, new Date())),
        exceptInviteEmail ? ne(invitations.email, exceptInviteEmail) : undefined,
      ),
    );
  return (active?.n ?? 0) + (pending?.n ?? 0);
}

/**
 * Plan-limit enforcement. Call before creating `adding` more of `meter` (order import: one call
 * per import with the number of new orders; invite: `users`; connect: `connections`). Throws
 * PLAN_LIMIT_REACHED when the limit would be exceeded — for `orders` only when the
 * subscription's overLimitBehavior is `block_imports`; with the default `warn` the import
 * continues and a `plan.limit_reached` event is emitted. An `orders` check (an import) also
 * throws PAYMENT_REQUIRED once the trial has expired. Vendor organizations have no limits.
 */
export async function assertWithinPlan(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId">,
  meterName: PlanMeter,
  adding = 1,
  opts: { exceptInviteEmail?: string } = {},
): Promise<{ used: number; limit: number | null; overLimit: boolean }> {
  if ((await companyType(tx, ctx.companyId)) !== "shop")
    return { used: 0, limit: null, overLimit: false };
  if (meterName === "orders") await assertPaidActionAllowed(tx, ctx);
  const plan = await getPlan(tx, ctx.companyId);
  const limit = {
    orders: plan.ordersPerMonth,
    aiCredits: plan.aiCreditsPerMonth,
    users: plan.maxUsers,
    connections: plan.maxConnections,
  }[meterName];
  if (limit == null) return { used: 0, limit: null, overLimit: false };
  const used =
    meterName === "users"
      ? await seatsInUse(tx, ctx.companyId, opts.exceptInviteEmail)
      : (await currentUsage(tx, ctx.companyId))[meterName];
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

/**
 * Nightly: trials past `trialEndsAt` with no Stripe subscription become `trial_expired`.
 * Cross-tenant, so it runs as the system role (a job, no request).
 */
export async function expireTrials(now = new Date()) {
  return withSystem(async (tx) => {
    const rows = await tx
      .update(subscriptions)
      .set({ status: "trial_expired" })
      .where(
        and(
          eq(subscriptions.status, "trialing"),
          lt(subscriptions.trialEndsAt, now),
          isNull(subscriptions.stripeSubscriptionId),
          inArray(
            subscriptions.companyId,
            tx.select({ id: companies.id }).from(companies).where(eq(companies.type, "shop")),
          ),
        ),
      )
      .returning({ companyId: subscriptions.companyId });
    for (const r of rows) {
      await audit(tx, {
        companyId: r.companyId,
        actor: { kind: "system" },
        action: "billing.trial_expired",
        entityType: "company",
        entityId: r.companyId,
        summary: "Free trial ended with no plan",
      });
    }
    if (rows.length) log.info("trials expired", { count: rows.length });
    return { expired: rows.length };
  });
}
