import type { PlanKey } from "@invai/contracts";
import { and, eq, or } from "drizzle-orm";
import { type Tx, withSystem } from "../../db/client";
import {
  aiCreditLedger,
  BILLING_WEBHOOK_EVENT_RETENTION_MS,
  billingWebhookEvents,
  companies,
  subscriptions,
} from "../../db/schema";
import { type BillingEvent, PLAN_LOOKUP_PREFIX } from "../../integrations/billing";
import { type Actor, audit } from "../../lib/audit";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import {
  AI_CREDIT_PACKS,
  isPackKey,
  isSelfServePlan,
  periodOf,
  type SubscriptionStatus,
} from "./service";

const log = logger("billing.webhook");
const stripeActor: Actor = { kind: "system" };

/*
 * Applies verified Stripe events. This is the only place the plan and subscription status
 * change while Stripe is live.
 *
 * Exactly once: the event row (unique on the Stripe event id) is inserted in the same
 * transaction that applies the event. A replay finds the row and does nothing; a failure rolls
 * both back and the route answers 500, so Stripe retries.
 *
 * Out of order: `subscriptions.stripe_event_at` holds the `created` time of the last event
 * applied; an older event is recorded as ignored and changes nothing. Checkout ids and credit
 * packs are not order-sensitive and always apply.
 *
 * withSystem: a webhook carries no tenant session. The company comes from the signed event
 * (our `client_reference_id`/metadata) or from the Stripe ids stored on its subscription, and
 * billing_webhook_events is written by the system role only (decision 0009's shape).
 */

type Outcome = { outcome: "processed" | "ignored" | "duplicate"; detail?: string };
type SubRow = typeof subscriptions.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleStripeEvent(ev: BillingEvent, now = new Date()): Promise<Outcome> {
  return withSystem(async (tx) => {
    const [row] = await tx
      .insert(billingWebhookEvents)
      .values({ stripeEventId: ev.id, type: ev.type, stripeCreatedAt: ev.created })
      .onConflictDoNothing()
      .returning({ id: billingWebhookEvents.id });
    if (!row) return { outcome: "duplicate" as const };

    const result = await apply(tx, ev, row.id, now);
    await tx
      .update(billingWebhookEvents)
      .set({
        status: result.outcome,
        companyId: result.companyId ?? null,
        processedAt: now,
        detail: result.detail?.slice(0, 500) ?? null,
      })
      .where(eq(billingWebhookEvents.id, row.id));
    log.info("stripe event", {
      eventId: ev.id,
      type: ev.type,
      outcome: result.outcome,
      companyId: result.companyId ?? null,
      detail: result.detail,
    });
    return { outcome: result.outcome, detail: result.detail };
  });
}

type Applied = { outcome: "processed" | "ignored"; companyId?: string | null; detail?: string };

async function apply(tx: Tx, ev: BillingEvent, eventRowId: string, now: Date): Promise<Applied> {
  if (ev.data.kind === "other") return { outcome: "ignored", detail: "event type not handled" };
  // Older than the dedupe window: its first delivery may already have been purged.
  if (now.getTime() - ev.created.getTime() > BILLING_WEBHOOK_EVENT_RETENTION_MS - 86_400_000)
    return { outcome: "ignored", detail: "event older than the dedupe window" };

  const d = ev.data;
  const companyId = await resolveCompany(tx, d);
  if (!companyId) return { outcome: "ignored", detail: "no InvAI company for this event" };
  const sub = await lockSubscription(tx, companyId);

  if (d.kind === "checkout") {
    if (d.mode === "payment") return applyPack(tx, ev, d, companyId, sub, eventRowId);
    if (d.mode !== "subscription")
      return { outcome: "ignored", companyId, detail: "checkout mode not handled" };
    await tx
      .update(subscriptions)
      .set({
        ...(d.customerId ? { stripeCustomerId: d.customerId } : {}),
        ...(d.subscriptionId ? { stripeSubscriptionId: d.subscriptionId } : {}),
      })
      .where(eq(subscriptions.id, sub.id));
    const plan = d.metadata.plan;
    if (!d.paid || !plan || !isSelfServePlan(plan))
      return { outcome: "processed", companyId, detail: "ids recorded" };
    if (isStale(sub, ev)) return { outcome: "processed", companyId, detail: "ids recorded; stale" };
    await setPlanAndStatus(tx, companyId, sub, ev, { plan, status: "active" });
    return { outcome: "processed", companyId };
  }

  if (d.kind === "subscription") {
    const current = sub.stripeSubscriptionId;
    const isCurrent = !current || current === d.subscriptionId || sub.status === "cancelled";
    if (!isCurrent && (d.deleted || !["active", "trialing"].includes(d.status)))
      return { outcome: "ignored", companyId, detail: "not the company's current subscription" };
    if (isStale(sub, ev)) return { outcome: "ignored", companyId, detail: "older than last event" };

    const ids = {
      stripeSubscriptionId: d.subscriptionId,
      ...(d.customerId ? { stripeCustomerId: d.customerId } : {}),
      ...(d.currentPeriodStart ? { currentPeriodStart: d.currentPeriodStart } : {}),
      currentPeriodEnd: d.currentPeriodEnd,
      cancelAtPeriodEnd: d.cancelAtPeriodEnd,
    };
    if (d.deleted || d.status === "canceled" || d.status === "incomplete_expired") {
      await setPlanAndStatus(tx, companyId, sub, ev, {
        plan: "trial",
        status: "cancelled",
        extra: { ...ids, cancelAtPeriodEnd: false },
      });
      return { outcome: "processed", companyId };
    }
    if (d.status === "active" || d.status === "trialing") {
      const plan = planOf(d.lookupKey, d.metadata.plan);
      if (!plan) {
        await setPlanAndStatus(tx, companyId, sub, ev, { status: "active", extra: ids });
        return { outcome: "processed", companyId, detail: "price has no InvAI plan; plan kept" };
      }
      await setPlanAndStatus(tx, companyId, sub, ev, { plan, status: "active", extra: ids });
      return { outcome: "processed", companyId };
    }
    if (d.status === "past_due" || d.status === "unpaid" || d.status === "paused") {
      await setPlanAndStatus(tx, companyId, sub, ev, { status: "past_due", extra: ids });
      return { outcome: "processed", companyId };
    }
    // incomplete: the first payment hasn't gone through; grant nothing yet.
    await setPlanAndStatus(tx, companyId, sub, ev, { extra: ids });
    return { outcome: "processed", companyId, detail: `subscription ${d.status}; plan unchanged` };
  }

  // invoice.paid / invoice.payment_failed
  if (!d.subscriptionId || d.subscriptionId !== sub.stripeSubscriptionId)
    return { outcome: "ignored", companyId, detail: "invoice is not for the current subscription" };
  if (isStale(sub, ev)) return { outcome: "ignored", companyId, detail: "older than last event" };
  if (d.paid) {
    await setPlanAndStatus(tx, companyId, sub, ev, {
      status: sub.status === "past_due" ? "active" : undefined,
    });
  } else {
    await setPlanAndStatus(tx, companyId, sub, ev, {
      status: sub.status === "active" ? "past_due" : undefined,
    });
  }
  return { outcome: "processed", companyId };
}

function isStale(sub: SubRow, ev: BillingEvent) {
  return !!sub.stripeEventAt && ev.created < sub.stripeEventAt;
}

function planOf(lookupKey: string | null, metaPlan: string | undefined): PlanKey | null {
  const fromPrice = lookupKey?.startsWith(PLAN_LOOKUP_PREFIX)
    ? lookupKey.slice(PLAN_LOOKUP_PREFIX.length)
    : null;
  if (fromPrice && isSelfServePlan(fromPrice)) return fromPrice;
  if (metaPlan && isSelfServePlan(metaPlan)) return metaPlan;
  return null;
}

async function resolveCompany(
  tx: Tx,
  d: Exclude<BillingEvent["data"], { kind: "other" }>,
): Promise<string | null> {
  const subId = "subscriptionId" in d ? d.subscriptionId : null;
  if (subId || d.customerId) {
    const [known] = await tx
      .select({ companyId: subscriptions.companyId })
      .from(subscriptions)
      .where(
        or(
          subId ? eq(subscriptions.stripeSubscriptionId, subId) : undefined,
          d.customerId ? eq(subscriptions.stripeCustomerId, d.customerId) : undefined,
        ),
      )
      .limit(1);
    if (known) return known.companyId;
  }
  if (d.companyRef && UUID.test(d.companyRef)) {
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.id, d.companyRef), eq(companies.type, "shop")));
    if (company) return company.id;
  }
  return null;
}

/** The company's subscription row, locked for this event (created if the org hook never ran). */
async function lockSubscription(tx: Tx, companyId: string): Promise<SubRow> {
  await tx
    .insert(subscriptions)
    .values({ companyId, planKey: "trial", status: "trialing" })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.companyId, companyId))
    .for("update");
  if (!row) throw new Error("subscription row missing after upsert");
  return row;
}

async function setPlanAndStatus(
  tx: Tx,
  companyId: string,
  sub: SubRow,
  ev: BillingEvent,
  change: {
    plan?: PlanKey;
    status?: SubscriptionStatus;
    extra?: Partial<typeof subscriptions.$inferInsert>;
  },
) {
  const [company] = await tx
    .select({ plan: companies.plan })
    .from(companies)
    .where(eq(companies.id, companyId));
  const before = { plan: company?.plan ?? "trial", status: sub.status };
  const planChanged = change.plan !== undefined && change.plan !== before.plan;
  const statusChanged = change.status !== undefined && change.status !== before.status;
  await tx
    .update(subscriptions)
    .set({
      ...change.extra,
      ...(change.plan ? { planKey: change.plan } : {}),
      ...(change.status ? { status: change.status } : {}),
      stripeEventAt: ev.created,
    })
    .where(eq(subscriptions.id, sub.id));
  if (planChanged && change.plan) {
    await tx.update(companies).set({ plan: change.plan }).where(eq(companies.id, companyId));
    await emit(tx, companyId, "plan.changed", { orgId: companyId, plan: change.plan });
  }
  if (planChanged || statusChanged) {
    await audit(tx, {
      companyId,
      actor: stripeActor,
      action: "billing.stripe_update",
      entityType: "company",
      entityId: companyId,
      summary: `${before.plan}/${before.status} -> ${change.plan ?? before.plan}/${change.status ?? before.status}`,
      data: { stripeEventId: ev.id, type: ev.type },
    });
  }
}

async function applyPack(
  tx: Tx,
  ev: BillingEvent,
  d: Extract<BillingEvent["data"], { kind: "checkout" }>,
  companyId: string,
  sub: SubRow,
  eventRowId: string,
): Promise<Applied> {
  const pack = d.metadata.pack;
  if (!pack || !isPackKey(pack))
    return { outcome: "ignored", companyId, detail: "payment is not a known credit pack" };
  if (!d.paid) return { outcome: "ignored", companyId, detail: "pack payment not completed" };
  if (d.customerId && !sub.stripeCustomerId)
    await tx
      .update(subscriptions)
      .set({ stripeCustomerId: d.customerId })
      .where(eq(subscriptions.id, sub.id));
  const credits = AI_CREDIT_PACKS[pack].credits;
  // Idempotent on the Stripe event id: this runs only in the transaction that first records it.
  await tx.insert(aiCreditLedger).values({
    companyId,
    kind: "pack",
    credits,
    refType: "billing_webhook_event",
    refId: eventRowId,
    period: periodOf(ev.created).key,
  });
  await audit(tx, {
    companyId,
    actor: stripeActor,
    action: "billing.pack_purchased",
    entityType: "company",
    entityId: companyId,
    summary: `${credits} AI credits added`,
    data: { pack, stripeEventId: ev.id },
  });
  return { outcome: "processed", companyId };
}
