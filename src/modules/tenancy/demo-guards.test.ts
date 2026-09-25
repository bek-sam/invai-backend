import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { channelConnections, companies, subscriptions, suppliers } from "../../db/schema";
import { env } from "../../env";
import { billingProvider } from "../../integrations/billing";
import { carrierAdapter, carrierTracking } from "../../integrations/carriers";
import { getChannelAdapter } from "../../integrations/channels";
import { getSupplierAdapter } from "../../integrations/suppliers";
import { vendorAdapter } from "../../integrations/vendors";
import { sendMail } from "../../integrations/vendors/mailer";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import {
  assertWithinPlan,
  checkout,
  getStatus,
  portal,
  requestPlanChange,
} from "../billing/service";
import { syncConnection } from "../channels/sync";
import { listSuppliers, supplierAdapterFor } from "../inventory/service";
import { getSettings, isMockCarrier } from "../shipping/service";
import { onOrganizationCreated } from "../today/org-hooks";
import { clearSampleWorkspaceCache, isSampleWorkspace } from "./demo-flag";
import { inviteSenders, sendInviteEmail } from "./invites";

/*
 * T-6-5 (B-109): a sample workspace (tenancy.demo, `demoOwnerUserId IS NOT NULL`) never spends
 * real money. Every real provider is replaced by a spy that records the call, the env says real
 * keys are set, and the sample workspace must never reach one — while a real company (including
 * the seeded demo shop: `companies.demo` but no demo owner) still does.
 */

const real = vi.hoisted(() => {
  const calls: string[] = [];
  /** A "live" provider: every method records `name.method` and answers something plausible. */
  function spy<T>(name: string, fields: Record<string, unknown>): T {
    return new Proxy(fields, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        if (typeof prop !== "string" || prop === "then") return undefined;
        return async () => {
          calls.push(`${name}.${prop}`);
          return { id: "live_1", url: "https://live.invalid/checkout" };
        };
      },
    }) as T;
  }
  return { calls, spy };
});

vi.mock("../../integrations/carriers/easypost", async (orig) => ({
  ...(await orig<object>()),
  easypostCarrier: real.spy("easypost", { provider: "easypost" }),
  easypostTracking: real.spy("easypostTracking", { provider: "easypost" }),
}));
vi.mock("../../integrations/channels/shopify", async (orig) => {
  const actual = await orig<typeof import("../../integrations/channels/shopify")>();
  const live = real.spy("shopify", { channel: "shopify", pendingApproval: false });
  return {
    ...actual,
    shopifyAdapter: (provider?: "live" | "mock") =>
      provider === "mock" ? actual.shopifyAdapter("mock") : live,
  };
});
vi.mock("../../integrations/billing/stripe", async (orig) => ({
  ...(await orig<object>()),
  createStripeProvider: () => real.spy("stripe", { kind: "live" }),
}));
vi.mock("../../integrations/suppliers/ssactivewear", async (orig) => ({
  ...(await orig<object>()),
  ssActivewearAdapter: () => real.spy("ssactivewear", { provider: "live" }),
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (m: { to: string }) => {
        real.calls.push(`smtp:${m.to}`);
        return { messageId: "smtp-1" };
      },
    }),
  },
}));

type Flags = { carrier: boolean; shopify: boolean; billing: boolean };
const flags = env.mocks as unknown as Flags;
const mutableEnv = env as unknown as { STRIPE_SECRET_KEY?: string };
const saved = { ...flags, stripe: mutableEnv.STRIPE_SECRET_KEY };

let sample: string; // a user's sample workspace
let retired: string; // a reset demo: owner link gone, still sample
let seeded: string; // the seeded Desert Bloom shape: companies.demo = true, no demo owner
let sampleOwner: string;
let seededOwner: string;

async function makeCompany(set: Partial<typeof companies.$inferInsert>) {
  const c = await createCompany();
  const owner = await createUser(c.id, "owner");
  await withSystem((tx) => tx.update(companies).set(set).where(eq(companies.id, c.id)));
  return { id: c.id, owner: owner.id };
}

beforeAll(async () => {
  flags.carrier = false;
  flags.shopify = false;
  flags.billing = false;
  mutableEnv.STRIPE_SECRET_KEY = "sk_live_not_really";
  clearSampleWorkspaceCache();
  const s = await createCompany();
  sampleOwner = (await createUser(s.id, "owner")).id;
  await withSystem((tx) =>
    tx
      .update(companies)
      .set({ demo: true, demoOwnerUserId: sampleOwner })
      .where(eq(companies.id, s.id)),
  );
  sample = s.id;
  retired = (
    await makeCompany({ demo: true, settings: { demoRetiredAt: new Date().toISOString() } })
  ).id;
  const d = await makeCompany({ demo: true });
  seeded = d.id;
  seededOwner = d.owner;
});

afterAll(() => {
  Object.assign(flags, { carrier: saved.carrier, shopify: saved.shopify, billing: saved.billing });
  mutableEnv.STRIPE_SECRET_KEY = saved.stripe;
});

beforeEach(() => {
  real.calls.length = 0;
});

describe("which companies are sample workspaces", () => {
  it("a demo owner or a retired demo is; the seeded demo shop (companies.demo) is not", async () => {
    expect(await isSampleWorkspace(sample)).toBe(true);
    expect(await isSampleWorkspace(retired)).toBe(true);
    expect(await isSampleWorkspace(seeded)).toBe(false);
    expect(await isSampleWorkspace(crypto.randomUUID())).toBe(false);
  });
});

describe("carrier (labels, tracking)", () => {
  it("a sample workspace gets the mock carrier at every call site; a real shop gets EasyPost", async () => {
    for (const companyId of [sample, retired]) {
      expect((await carrierAdapter({ companyId })).provider).toBe("mock");
      expect((await carrierTracking({ companyId })).provider).toBe("mock");
      expect(await isMockCarrier(companyId)).toBe(true); // shipping.scheduleMockTracking job
      const settings = await withTenant(companyId, (tx) =>
        getSettings(tx, tenantContext(companyId, null, "owner")),
      );
      expect(settings.carrierProvider).toBe("mock");
    }
    expect(real.calls).toEqual([]);

    expect((await carrierAdapter({ companyId: seeded })).provider).toBe("easypost");
    expect(await isMockCarrier(seeded)).toBe(false);
    await (await carrierAdapter({ companyId: seeded })).rate({} as never);
    expect(real.calls).toEqual(["easypost.rate"]);
  });
});

describe("marketplaces", () => {
  it("the factory ignores a stored live provider for a sample workspace", async () => {
    for (const kind of ["shopify", "etsy"] as const) {
      const mock = await getChannelAdapter(kind, "mock", { companyId: seeded });
      expect(await getChannelAdapter(kind, "live", { companyId: sample })).toBe(mock);
      expect(await getChannelAdapter(kind, "live", { companyId: retired })).toBe(mock);
    }
    expect(await getChannelAdapter("shopify", "live", { companyId: seeded })).not.toBe(
      await getChannelAdapter("shopify", "mock", { companyId: seeded }),
    );
    const shopify = await getChannelAdapter("shopify", "live", { companyId: seeded });
    await shopify.fetchOrders({} as never);
    expect(real.calls).toEqual(["shopify.fetchOrders"]);
  });

  it("an order sync of a sample workspace's live-marked Shopify connection never calls Shopify", async () => {
    const [conn] = await withSystem((tx) =>
      tx
        .insert(channelConnections)
        .values({
          companyId: sample,
          channel: "shopify",
          name: "Looks live",
          status: "connected",
          mode: "api",
          provider: "live",
          externalShopId: `t65-${Date.now()}.myshopify.com`,
        })
        .returning(),
    );
    if (!conn) throw new Error("insert failed");
    await syncConnection(sample, conn.id).catch(() => undefined);
    expect(real.calls.filter((c) => c.startsWith("shopify."))).toEqual([]);
  });
});

describe("billing (Stripe)", () => {
  it("checkout, portal and plan changes answer DEMO_MODE in a sample workspace", async () => {
    const ctx = tenantContext(sample, sampleOwner, "owner");
    await expect(checkout(ctx, { plan: "growth" })).rejects.toMatchObject({ code: "DEMO_MODE" });
    await expect(checkout(ctx, { pack: "credits_500" })).rejects.toMatchObject({
      code: "DEMO_MODE",
    });
    await expect(portal(ctx)).rejects.toMatchObject({ code: "DEMO_MODE" });
    await expect(requestPlanChange(ctx, "pro")).rejects.toMatchObject({ code: "DEMO_MODE" });
    expect((await billingProvider({ companyId: sample })).kind).toBe("mock");
    const status = await withTenant(sample, (tx) => getStatus(tx, ctx));
    expect(status.paymentsEnabled).toBe(false);
    expect(real.calls).toEqual([]);
  });

  it("the seeded demo shop still reaches Stripe", async () => {
    const ctx = tenantContext(seeded, seededOwner, "owner");
    await checkout(ctx, { plan: "growth" });
    expect(real.calls).toEqual(["stripe.createCheckout"]);
  });
});

describe("suppliers (S&S orders)", () => {
  it("a sample workspace with its own S&S keys still gets the mock supplier", async () => {
    await withSystem((tx) =>
      tx.insert(suppliers).values([
        {
          companyId: sample,
          supplier: "ssactivewear",
          name: "S&S",
          accountNumber: "1",
          apiKey: "k",
        },
        {
          companyId: seeded,
          supplier: "ssactivewear",
          name: "S&S",
          accountNumber: "1",
          apiKey: "k",
        },
      ]),
    );
    const creds = { account: "1", apiKey: "k" };
    const opts = { production: true };
    expect(
      (await getSupplierAdapter("ssactivewear", creds, { companyId: sample, ...opts }))?.provider,
    ).toBe("mock");
    const viaService = await withTenant(sample, (tx) =>
      supplierAdapterFor(tx, sample, "ssactivewear"),
    );
    expect(viaService?.provider).toBe("mock");
    const listed = await withTenant(sample, (tx) =>
      listSuppliers(tx, tenantContext(sample, sampleOwner, "owner")),
    );
    expect(listed.items.find((s) => s.supplier === "ssactivewear")?.provider).toBe("mock");
    await viaService?.stock(["B1"]);
    expect(real.calls).toEqual([]);

    const live = await withTenant(seeded, (tx) => supplierAdapterFor(tx, seeded, "ssactivewear"));
    expect(live?.provider).toBe("live");
  });
});

describe("email", () => {
  const vendorSheet = (companyId: string) => ({
    companyId,
    sheetId: crypto.randomUUID(),
    sheetName: "S-1",
    shopName: "Shop",
    vendor: { name: "V", email: "vendor@example.com", vendorCompanyId: null },
    lengthIn: 10,
    widthIn: 22,
    transferCount: 3,
    format: "png" as const,
    note: null,
    links: { png: null, pdf: null, preview: null, expiresAt: new Date().toISOString() },
  });

  it("a sample workspace sends no invite, vendor or other company mail", async () => {
    const senders = await inviteSenders(sample, sampleOwner);
    await sendInviteEmail("new@example.com", {
      ...senders,
      kind: "staff",
      role: "office",
      link: "http://web/accept-invite/x",
      expiresAt: new Date(),
    });
    await vendorAdapter("email").deliver(vendorSheet(sample));
    await vendorAdapter("portal").deliver(vendorSheet(retired));
    expect(
      await sendMail({ to: "a@example.com", subject: "s", text: "t" }, { companyId: sample }),
    ).toEqual({ messageId: "skipped:sample-workspace" });
    expect(real.calls).toEqual([]);
  });

  it("the seeded demo shop sends invites and vendor mail; account mail always goes", async () => {
    const senders = await inviteSenders(seeded, seededOwner);
    await sendInviteEmail("staff@example.com", {
      ...senders,
      kind: "staff",
      role: "office",
      link: "http://web/accept-invite/x",
      expiresAt: new Date(),
    });
    await vendorAdapter("email").deliver(vendorSheet(seeded));
    await sendMail({ to: "me@example.com", subject: "Reset", text: "t" }, "account");
    expect(real.calls).toEqual([
      "smtp:staff@example.com",
      "smtp:vendor@example.com",
      "smtp:me@example.com",
    ]);
  });
});

describe("plans (regression: the seeded demo shop is a real shop)", () => {
  it("gets a trial from the org hook and is held to plan limits; a sample workspace is not", async () => {
    await onOrganizationCreated({ id: seeded, type: "shop" });
    const subs = await withTenant(seeded, (tx) => tx.select().from(subscriptions));
    expect(subs).toHaveLength(1);
    const limited = await withTenant(seeded, (tx) =>
      assertWithinPlan(tx, { companyId: seeded }, "users", 0),
    );
    expect(limited.limit).not.toBeNull();

    await onOrganizationCreated({ id: sample, type: "shop" });
    expect(await withTenant(sample, (tx) => tx.select().from(subscriptions))).toEqual([]);
    const free = await withTenant(sample, (tx) =>
      assertWithinPlan(tx, { companyId: sample }, "users", 10_000),
    );
    expect(free.limit).toBeNull();
  });
});
