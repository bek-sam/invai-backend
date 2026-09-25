import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelConn } from "../types";
import { resetShopifyThrottle, setShopifySleep } from "./client";
import { shopifyLive } from "./live";

const uri = "https://api.example.test/webhooks/shopify";
const conn: ChannelConn = {
  id: "00000000-0000-4000-8000-000000000003",
  companyId: "00000000-0000-4000-8000-000000000002",
  channel: "shopify",
  name: "Test",
  mode: "api",
  provider: "live",
  externalShopId: "t31-subs.myshopify.com",
  cursor: null,
  credentials: {
    accessToken: "shpat_test",
    webhooks: {
      checkedAt: "2026-09-20T00:00:00Z",
      subscriptionIds: ["gid://shopify/WebhookSubscription/1"],
      failures: [],
    },
  },
};

type Call = { query: string; variables: Record<string, unknown> };

function stub(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)) as Call;
      calls.push(call);
      return new Response(JSON.stringify(handler(call)), { status: 200 });
    }),
  );
  return calls;
}

let restore: () => void;
beforeEach(() => {
  resetShopifyThrottle();
  restore = setShopifySleep(async () => {});
});
afterEach(() => {
  restore();
  vi.unstubAllGlobals();
});

describe("Shopify webhook subscriptions", () => {
  it("creates only the missing topics and reports the ones Shopify refuses", async () => {
    const calls = stub((c) => {
      if (c.query.includes("webhookSubscriptions("))
        return {
          data: {
            webhookSubscriptions: {
              nodes: [
                { id: "gid://shopify/WebhookSubscription/1", topic: "ORDERS_CREATE", uri },
                // Someone else's endpoint for the same topic doesn't count.
                { id: "gid://shopify/WebhookSubscription/9", topic: "ORDERS_UPDATED", uri: "x" },
              ],
            },
          },
        };
      if (c.variables.topic === "ORDERS_CANCELLED")
        return {
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: null,
              userErrors: [{ field: ["topic"], message: "Access denied for topic" }],
            },
          },
        };
      return {
        data: {
          webhookSubscriptionCreate: {
            webhookSubscription: { id: `gid://shopify/WebhookSubscription/${c.variables.topic}` },
            userErrors: [],
          },
        },
      };
    });
    const state = await shopifyLive.ensureWebhooks?.(conn, uri);
    const created = calls.filter((c) => c.query.includes("webhookSubscriptionCreate"));
    expect(created.map((c) => c.variables.topic)).toEqual([
      "ORDERS_UPDATED",
      "ORDERS_CANCELLED",
      "APP_UNINSTALLED",
    ]);
    expect(created[0]?.variables.sub).toEqual({ uri, format: "JSON" });
    expect(state?.subscriptionIds).toEqual([
      "gid://shopify/WebhookSubscription/1",
      "gid://shopify/WebhookSubscription/ORDERS_UPDATED",
      "gid://shopify/WebhookSubscription/APP_UNINSTALLED",
    ]);
    expect(state?.failures).toEqual([
      { topic: "ORDERS_CANCELLED", message: "Access denied for topic" },
    ]);
  });

  it("a listing failure degrades every topic instead of throwing", async () => {
    stub(() => ({ errors: [{ message: "Internal error" }] }));
    const state = await shopifyLive.ensureWebhooks?.(conn, uri);
    expect(state?.failures).toHaveLength(1);
    expect(state?.failures[0]?.topic).toBe("*");
  });

  it("disconnect deletes our subscriptions, then uninstalls the app (revoking the token)", async () => {
    const calls = stub((c) => {
      if (c.query.includes("webhookSubscriptions("))
        return {
          data: {
            webhookSubscriptions: {
              nodes: [
                { id: "gid://shopify/WebhookSubscription/1", topic: "ORDERS_CREATE", uri },
                { id: "gid://shopify/WebhookSubscription/2", topic: "APP_UNINSTALLED", uri },
              ],
            },
          },
        };
      if (c.query.includes("webhookSubscriptionDelete"))
        return {
          data: {
            webhookSubscriptionDelete: {
              deletedWebhookSubscriptionId: c.variables.id,
              userErrors: [],
            },
          },
        };
      return { data: { appUninstall: { app: { id: "gid://shopify/App/1" }, userErrors: [] } } };
    });
    const res = await shopifyLive.disconnect?.(conn, uri);
    expect(res).toEqual({ unsubscribed: 2, uninstalled: true, errors: [] });
    const deleted = calls.filter((c) => c.query.includes("webhookSubscriptionDelete"));
    expect(deleted.map((c) => c.variables.id).sort()).toEqual([
      "gid://shopify/WebhookSubscription/1",
      "gid://shopify/WebhookSubscription/2",
    ]);
    expect(calls.at(-1)?.query).toContain("appUninstall");
  });

  it("disconnect never throws: a revoked token is reported, not raised", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    const res = await shopifyLive.disconnect?.(conn, uri);
    expect(res?.uninstalled).toBe(false);
    expect(res?.unsubscribed).toBe(0);
    expect(res?.errors.length).toBeGreaterThan(0);
  });
});
