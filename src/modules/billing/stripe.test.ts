import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../api/app";
import { withSystem, withTenant } from "../../db/client";
import {
  aiCreditLedger,
  auditLog,
  billingWebhookEvents,
  companies,
  subscriptions,
} from "../../db/schema";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";

/*
 * Stripe billing against the real Stripe SDK with a mocked `fetch` (no network, no keys):
 * checkout/portal/changePlan requests, and the signed `/webhooks/stripe` route — signature,
 * every handled event type, replays, out-of-order delivery and rollback on failure.
 */

type Call = { method: string; path: string; body: URLSearchParams };
const stripe = vi.hoisted(() => ({
  live: false,
  calls: [] as Call[],
  failEmit: false,
}));

function fakeStripeFetch(): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = init?.method ?? "GET";
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    stripe.calls.push({ method, path: url.pathname, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json", "request-id": "req_test" },
      });
    if (url.pathname === "/v1/prices") {
      const key = url.searchParams.get("lookup_keys[0]") ?? "";
      if (key === "invai_plan_missing")
        return json(200, { object: "list", data: [], has_more: false });
      return json(200, {
        object: "list",
        data: [{ id: `price_${key}`, object: "price", lookup_key: key }],
        has_more: false,
      });
    }
    if (url.pathname === "/v1/checkout/sessions")
      return json(200, {
        id: "cs_test_1",
        object: "checkout.session",
        url: "https://checkout.stripe.com/c/pay/cs_test_1",
      });
    if (url.pathname === "/v1/billing_portal/sessions")
      return json(200, {
        id: "bps_1",
        object: "billing_portal.session",
        url: "https://billing.stripe.com/p/session/test_1",
      });
    if (url.pathname.startsWith("/v1/subscriptions/"))
      return json(200, { id: url.pathname.split("/").pop(), object: "subscription" });
    return json(404, { error: { type: "invalid_request_error", message: "No such thing" } });
  };
}

vi.mock("../../integrations/billing", async (orig) => {
  const real = await orig<typeof import("../../integrations/billing")>();
  const { createStripeProvider } = await import("../../integrations/billing/stripe");
  const live = createStripeProvider("sk_test_invai_fake", { fetch: fakeStripeFetch() });
  return {
    ...real,
    billingProvider: async (scope: { companyId: string }) =>
      stripe.live ? live : real.billingProvider(scope),
  };
});

vi.mock("../../lib/outbox", async (orig) => {
  const real = await orig<typeof import("../../lib/outbox")>();
  return {
    ...real,
    emit: vi.fn(async (...args: Parameters<typeof real.emit>) => {
      if (stripe.failEmit) throw new Error("outbox down");
      return real.emit(...args);
    }),
  };
});

const svc = await import("./service");
const { signStripeWebhook, MOCK_STRIPE_WEBHOOK_SECRET } = await import(
  "../../integrations/billing"
);

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

let seq = 0;
function event(type: string, object: Record<string, unknown>, created = new Date()) {
  seq += 1;
  return {
    id: `evt_${uniq()}_${seq}`,
    object: "event",
    type,
    created: unix(created),
    livemode: false,
    api_version: "2026-08-26.dahlia",
    data: { object },
  };
}

function post(body: string, signature?: string) {
  return app.request("/webhooks/stripe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === undefined ? { "stripe-signature": signStripeWebhook(body) } : {}),
      ...(signature ? { "stripe-signature": signature } : {}),
    },
    body,
  });
}
const send = (ev: ReturnType<typeof event>) => post(JSON.stringify(ev));

function subscriptionObject(
  companyId: string,
  subId: string,
  status: string,
  plan: string,
  over: Record<string, unknown> = {},
) {
  const start = new Date();
  const end = new Date(start.getTime() + 30 * 86_400_000);
  return {
    id: subId,
    object: "subscription",
    customer: `cus_${companyId}`,
    status,
    cancel_at_period_end: false,
    metadata: { companyId, plan },
    items: {
      object: "list",
      data: [
        {
          id: `si_${subId}`,
          object: "subscription_item",
          current_period_start: unix(start),
          current_period_end: unix(end),
          price: { id: `price_${plan}`, object: "price", lookup_key: `invai_plan_${plan}` },
        },
      ],
    },
    ...over,
  };
}

async function state(companyId: string) {
  return withSystem(async (tx) => {
    const [c] = await tx.select().from(companies).where(eq(companies.id, companyId));
    const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.companyId, companyId));
    return { plan: c?.plan, sub: s };
  });
}

async function shop() {
  const companyId = (await createCompany()).id;
  const owner = await createUser(companyId, "owner");
  await withSystem((tx) =>
    tx.insert(subscriptions).values({
      companyId,
      planKey: "trial",
      status: "trialing",
      trialEndsAt: new Date(Date.now() + 7 * 86_400_000),
    }),
  );
  return { companyId, ctx: tenantContext(companyId, owner.id, "owner") };
}

beforeEach(() => {
  stripe.live = false;
  stripe.calls = [];
  stripe.failEmit = false;
});

describe("billing.checkout, portal and changePlan against the Stripe SDK", () => {
  let a: Awaited<ReturnType<typeof shop>>;
  beforeAll(async () => {
    a = await shop();
  });

  it("creates a subscription Checkout session for the plan's price and never changes the plan", async () => {
    stripe.live = true;
    const res = await svc.checkout(a.ctx, { plan: "growth" });
    expect(res.url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    const prices = stripe.calls.find((c) => c.path === "/v1/prices");
    expect(prices).toBeTruthy();
    const create = stripe.calls.find((c) => c.path === "/v1/checkout/sessions");
    expect(create?.method).toBe("POST");
    expect(create?.body.get("mode")).toBe("subscription");
    expect(create?.body.get("client_reference_id")).toBe(a.companyId);
    expect(create?.body.get("line_items[0][price]")).toBe("price_invai_plan_growth");
    expect(create?.body.get("metadata[plan]")).toBe("growth");
    expect(create?.body.get("subscription_data[metadata][companyId]")).toBe(a.companyId);
    expect(create?.body.get("success_url")).toContain("/settings/billing?checkout=success");
    expect((await state(a.companyId)).plan).toBe("trial");
  });

  it("sells credit packs as one-time payments and accepts only known pack keys", async () => {
    stripe.live = true;
    await svc.checkout(a.ctx, { pack: "credits_500" });
    const create = stripe.calls.find((c) => c.path === "/v1/checkout/sessions");
    expect(create?.body.get("mode")).toBe("payment");
    expect(create?.body.get("customer_creation")).toBe("always");
    expect(create?.body.get("metadata[pack]")).toBe("credits_500");
    await expect(svc.checkout(a.ctx, { pack: "credits_999999" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(svc.checkout(a.ctx, { plan: "trial" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("maps a Stripe failure to UPSTREAM_FAILED", async () => {
    stripe.live = true;
    const provider = await (await import("../../integrations/billing")).billingProvider(a);
    await expect(
      provider.createCheckout({
        companyId: a.companyId,
        customerId: null,
        mode: "subscription",
        lookupKey: "invai_plan_missing",
        metadata: {},
        successUrl: "http://localhost/s",
        cancelUrl: "http://localhost/c",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_FAILED" });
  });

  it("with live Stripe, changePlan refuses a paid plan with PAYMENT_REQUIRED and a checkout URL", async () => {
    stripe.live = true;
    await expect(svc.requestPlanChange(a.ctx, "pro")).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
      data: { checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1" },
    });
    expect((await state(a.companyId)).plan).toBe("trial");
  });

  it("with mock Stripe, changePlan still applies at once (demos) and checkout returns a local URL", async () => {
    const b = await shop();
    const res = await svc.requestPlanChange(b.ctx, "starter");
    expect(res.status).toMatchObject({ plan: { key: "starter" }, paymentsEnabled: false });
    const { url } = await svc.checkout(b.ctx, { plan: "growth" });
    expect(url).toContain("/settings/billing?checkout=success&mock=1");
    expect((await state(b.companyId)).plan).toBe("starter");
    expect(stripe.calls).toHaveLength(0);
  });

  it("portal needs a Stripe customer; with one it returns Stripe's URL", async () => {
    stripe.live = true;
    await expect(svc.portal(a.ctx)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await withSystem((tx) =>
      tx
        .update(subscriptions)
        .set({ stripeCustomerId: `cus_portal_${a.companyId}` })
        .where(eq(subscriptions.companyId, a.companyId)),
    );
    const { url } = await svc.portal(a.ctx);
    expect(url).toBe("https://billing.stripe.com/p/session/test_1");
    const call = stripe.calls.find((c) => c.path === "/v1/billing_portal/sessions");
    expect(call?.body.get("customer")).toBe(`cus_portal_${a.companyId}`);
  });

  it("with live Stripe, downgrading to free cancels the subscription at period end", async () => {
    const c = await shop();
    await withSystem(async (tx) => {
      await tx.update(companies).set({ plan: "growth" }).where(eq(companies.id, c.companyId));
      await tx
        .update(subscriptions)
        .set({ planKey: "growth", status: "active", stripeSubscriptionId: "sub_live_1" })
        .where(eq(subscriptions.companyId, c.companyId));
    });
    stripe.live = true;
    const res = await svc.requestPlanChange(c.ctx, "trial");
    expect(res.status).toMatchObject({ plan: { key: "growth" }, cancelAtPeriodEnd: true });
    const call = stripe.calls.find((x) => x.path === "/v1/subscriptions/sub_live_1");
    expect(call?.body.get("cancel_at_period_end")).toBe("true");
    // A paid plan while subscribed goes through the portal, not a second subscription.
    await expect(svc.checkout(c.ctx, { plan: "pro" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("with live Stripe and no subscription, downgrading to free applies now without restarting the trial", async () => {
    const c = await shop();
    await withSystem(async (tx) => {
      await tx.update(companies).set({ plan: "starter" }).where(eq(companies.id, c.companyId));
      await tx
        .update(subscriptions)
        .set({ planKey: "starter", status: "active", trialEndsAt: new Date(Date.now() - 1000) })
        .where(eq(subscriptions.companyId, c.companyId));
    });
    stripe.live = true;
    const res = await svc.requestPlanChange(c.ctx, "trial");
    expect(res.status.plan.key).toBe("trial");
    expect(res.status.status).toBe("cancelled");
    expect(stripe.calls).toHaveLength(0);
  });

  it("getStatus reports paymentsEnabled only when Stripe is live", async () => {
    expect((await withTenant(a.companyId, (tx) => svc.getStatus(tx, a.ctx))).paymentsEnabled).toBe(
      false,
    );
    stripe.live = true;
    expect((await withTenant(a.companyId, (tx) => svc.getStatus(tx, a.ctx))).paymentsEnabled).toBe(
      true,
    );
  });
});

describe("POST /webhooks/stripe", () => {
  it("refuses a bad, missing or stale signature and writes nothing", async () => {
    const { companyId } = await shop();
    const ev = event(
      "customer.subscription.created",
      subscriptionObject(companyId, `sub_${uniq()}`, "active", "pro"),
    );
    const body = JSON.stringify(ev);
    expect((await post(body, "t=1,v1=deadbeef")).status).toBe(401);
    expect((await post(body, "")).status).toBe(401);
    const old = signStripeWebhook(
      body,
      MOCK_STRIPE_WEBHOOK_SECRET,
      new Date(Date.now() - 10 * 60_000),
    );
    expect((await post(body, old)).status).toBe(401);
    const wrongSecret = signStripeWebhook(body, "whsec_someone_else");
    expect((await post(body, wrongSecret)).status).toBe(401);
    const rows = await withSystem((tx) =>
      tx.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.stripeEventId, ev.id)),
    );
    expect(rows).toHaveLength(0);
    expect((await state(companyId)).plan).toBe("trial");
  });

  it("checkout.session.completed records the Stripe ids and activates the paid plan", async () => {
    const { companyId } = await shop();
    const subId = `sub_${uniq()}`;
    const res = await send(
      event("checkout.session.completed", {
        id: `cs_${uniq()}`,
        object: "checkout.session",
        mode: "subscription",
        client_reference_id: companyId,
        customer: `cus_checkout_${companyId}`,
        subscription: subId,
        payment_status: "paid",
        metadata: { companyId, plan: "growth" },
      }),
    );
    expect(res.status).toBe(200);
    const s = await state(companyId);
    expect(s.plan).toBe("growth");
    expect(s.sub).toMatchObject({
      status: "active",
      planKey: "growth",
      stripeCustomerId: `cus_checkout_${companyId}`,
      stripeSubscriptionId: subId,
    });
  });

  it("subscription created/updated/deleted and invoice paid/failed move plan and status", async () => {
    const { companyId, ctx } = await shop();
    const subId = `sub_${uniq()}`;
    const t0 = Date.now() - 60_000;
    const at = (s: number) => new Date(t0 + s * 1000);

    // Still incomplete: nothing granted yet.
    await send(
      event(
        "customer.subscription.created",
        subscriptionObject(companyId, subId, "incomplete", "starter"),
        at(1),
      ),
    );
    expect((await state(companyId)).plan).toBe("trial");
    expect((await state(companyId)).sub?.stripeSubscriptionId).toBe(subId);

    await send(
      event(
        "customer.subscription.updated",
        subscriptionObject(companyId, subId, "active", "starter"),
        at(2),
      ),
    );
    let s = await state(companyId);
    expect(s.plan).toBe("starter");
    expect(s.sub?.status).toBe("active");
    expect(s.sub?.currentPeriodEnd).toBeInstanceOf(Date);

    const invoice = (paid: boolean, when: number) =>
      event(
        paid ? "invoice.paid" : "invoice.payment_failed",
        {
          id: `in_${uniq()}`,
          object: "invoice",
          customer: `cus_${companyId}`,
          parent: {
            type: "subscription_details",
            subscription_details: { subscription: subId, metadata: { companyId } },
          },
        },
        at(when),
      );
    await send(invoice(false, 3));
    expect((await state(companyId)).sub?.status).toBe("past_due");
    const status = await withTenant(companyId, (tx) => svc.getStatus(tx, ctx));
    expect(status.status).toBe("past_due");
    await send(invoice(true, 4));
    expect((await state(companyId)).sub?.status).toBe("active");

    await send(
      event(
        "customer.subscription.updated",
        subscriptionObject(companyId, subId, "active", "growth", { cancel_at_period_end: true }),
        at(5),
      ),
    );
    s = await state(companyId);
    expect(s.plan).toBe("growth");
    expect(s.sub?.cancelAtPeriodEnd).toBe(true);

    await send(
      event(
        "customer.subscription.deleted",
        subscriptionObject(companyId, subId, "canceled", "growth"),
        at(6),
      ),
    );
    s = await state(companyId);
    expect(s.plan).toBe("trial");
    expect(s.sub).toMatchObject({ status: "cancelled", cancelAtPeriodEnd: false });

    const audits = await withSystem((tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.companyId, companyId), eq(auditLog.action, "billing.stripe_update")),
        ),
    );
    expect(audits.length).toBeGreaterThanOrEqual(4);
  });

  it("a replayed event is acknowledged and changes nothing", async () => {
    const { companyId } = await shop();
    const ev = event("checkout.session.completed", {
      id: `cs_${uniq()}`,
      object: "checkout.session",
      mode: "payment",
      client_reference_id: companyId,
      customer: `cus_pack_${companyId}`,
      subscription: null,
      payment_status: "paid",
      metadata: { companyId, pack: "credits_500" },
    });
    const first = await send(ev);
    expect(await first.json()).toMatchObject({ ok: true, outcome: "processed" });
    const again = await send(ev);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true });
    const packs = await withSystem((tx) =>
      tx
        .select()
        .from(aiCreditLedger)
        .where(and(eq(aiCreditLedger.companyId, companyId), eq(aiCreditLedger.kind, "pack"))),
    );
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ credits: 500, refType: "billing_webhook_event" });
    const events = await withSystem((tx) =>
      tx.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.stripeEventId, ev.id)),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "processed", companyId });
  });

  it("an unpaid pack or an unknown pack key adds no credits", async () => {
    const { companyId } = await shop();
    for (const [pack, payment_status] of [
      ["credits_500", "unpaid"],
      ["credits_bogus", "paid"],
    ]) {
      const res = await send(
        event("checkout.session.completed", {
          id: `cs_${uniq()}`,
          object: "checkout.session",
          mode: "payment",
          client_reference_id: companyId,
          customer: `cus_x_${companyId}`,
          payment_status,
          metadata: { companyId, pack },
        }),
      );
      expect(await res.json()).toMatchObject({ outcome: "ignored" });
    }
    const packs = await withSystem((tx) =>
      tx.select().from(aiCreditLedger).where(eq(aiCreditLedger.companyId, companyId)),
    );
    expect(packs).toHaveLength(0);
  });

  it("an older event delivered late is ignored (out of order)", async () => {
    const { companyId } = await shop();
    const subId = `sub_${uniq()}`;
    const now = Date.now();
    const newer = event(
      "customer.subscription.updated",
      subscriptionObject(companyId, subId, "active", "pro"),
      new Date(now - 10_000),
    );
    const older = event(
      "customer.subscription.updated",
      subscriptionObject(companyId, subId, "past_due", "starter"),
      new Date(now - 60_000),
    );
    await send(newer);
    const res = await send(older);
    expect(await res.json()).toMatchObject({ outcome: "ignored" });
    const s = await state(companyId);
    expect(s.plan).toBe("pro");
    expect(s.sub?.status).toBe("active");
    const [row] = await withSystem((tx) =>
      tx
        .select()
        .from(billingWebhookEvents)
        .where(eq(billingWebhookEvents.stripeEventId, older.id)),
    );
    expect(row).toMatchObject({ status: "ignored", detail: "older than last event" });
  });

  it("a deletion of an old subscription doesn't cancel the current one", async () => {
    const { companyId } = await shop();
    const current = `sub_${uniq()}`;
    await send(
      event(
        "customer.subscription.updated",
        subscriptionObject(companyId, current, "active", "growth"),
      ),
    );
    const res = await send(
      event(
        "customer.subscription.deleted",
        subscriptionObject(companyId, `sub_old_${uniq()}`, "canceled", "starter"),
      ),
    );
    expect(await res.json()).toMatchObject({ outcome: "ignored" });
    expect((await state(companyId)).plan).toBe("growth");
  });

  it("events for no InvAI company are acknowledged and ignored; unhandled types too", async () => {
    const stranger = await send(
      event(
        "customer.subscription.updated",
        subscriptionObject(
          "00000000-0000-4000-8000-000000000000",
          `sub_${uniq()}`,
          "active",
          "pro",
          { customer: `cus_${uniq()}` },
        ),
      ),
    );
    expect(stranger.status).toBe(200);
    expect(await stranger.json()).toMatchObject({ outcome: "ignored" });
    const other = await send(event("customer.created", { id: "cus_1", object: "customer" }));
    expect(await other.json()).toMatchObject({ outcome: "ignored" });
  });

  it("a failure rolls everything back and answers 500, so Stripe's retry is applied", async () => {
    const { companyId } = await shop();
    const ev = event(
      "customer.subscription.updated",
      subscriptionObject(companyId, `sub_${uniq()}`, "active", "starter"),
    );
    stripe.failEmit = true;
    expect((await send(ev)).status).toBe(500);
    const none = await withSystem((tx) =>
      tx.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.stripeEventId, ev.id)),
    );
    expect(none).toHaveLength(0);
    expect((await state(companyId)).plan).toBe("trial");
    stripe.failEmit = false;
    expect((await send(ev)).status).toBe(200);
    expect((await state(companyId)).plan).toBe("starter");
  });

  it("the app role reads only its own company's events and can't write them", async () => {
    const a = await shop();
    const b = await shop();
    const ev = event(
      "customer.subscription.updated",
      subscriptionObject(a.companyId, `sub_${uniq()}`, "active", "starter"),
    );
    await send(ev);
    const mine = await withTenant(a.companyId, (tx) =>
      tx.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.stripeEventId, ev.id)),
    );
    expect(mine).toHaveLength(1);
    const theirs = await withTenant(b.companyId, (tx) =>
      tx.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.stripeEventId, ev.id)),
    );
    expect(theirs).toHaveLength(0);
    await expect(
      withTenant(b.companyId, (tx) =>
        tx.insert(billingWebhookEvents).values({
          companyId: b.companyId,
          stripeEventId: `evt_claim_${uniq()}`,
          type: "x",
          stripeCreatedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });
});
