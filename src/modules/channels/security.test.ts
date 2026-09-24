import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { channelConnections } from "../../db/schema";
import { signShopifyBody } from "../../integrations/channels/shopify";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { connect } from "./service";
import {
  captureFields,
  compilePattern,
  execSku,
  MAX_SKU_MATCH_LEN,
  unsafeRegexReason,
} from "./sku";
import { completeShopifyOAuth, processWebhook } from "./sync";

const shopDomain = () =>
  `sec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.myshopify.com`;

function webhook(shop: string, topic: string, payload: unknown) {
  const body = JSON.stringify(payload);
  return {
    headers: {
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-hmac-sha256": signShopifyBody(body),
    },
    body,
  };
}

describe("Shopify connections are bound to a shop only after OAuth", () => {
  let a: ReturnType<typeof tenantContext>;
  let b: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    const ca = (await createCompany()).id;
    const cb = (await createCompany()).id;
    a = tenantContext(ca, (await createUser(ca, "owner")).id, "owner");
    b = tenantContext(cb, (await createUser(cb, "owner")).id, "owner");
  });

  const start = async (ctx: typeof a, shop: string) => {
    const res = await withTenant(ctx.companyId, (tx) =>
      connect(tx, ctx, { channel: "shopify", shopDomain: shop } as never),
    );
    const { connectionId, authorizeUrl } = res as { connectionId: string; authorizeUrl: string };
    const url = new URL(authorizeUrl);
    return { connectionId, state: url.searchParams.get("state") ?? "" };
  };

  it("a pending install for someone else's shop receives none of its webhooks", async () => {
    const shop = shopDomain();
    const pending = await start(b, shop);
    const [row] = await withSystem((tx) =>
      tx.select().from(channelConnections).where(eq(channelConnections.id, pending.connectionId)),
    );
    expect(row?.status).toBe("pending");
    expect(row?.externalShopId).toBeNull();
    const w = webhook(shop, "orders/cancelled", { id: 1 });
    const res = await processWebhook("shopify", w.headers, w.body);
    expect(res).toMatchObject({ handled: false });
  });

  it("the shop routes only to the company that finished OAuth; others are refused", async () => {
    const shop = shopDomain();
    const pendingB = await start(b, shop);
    const pendingA = await start(a, shop);
    // A wrong state or a state for a different shop does not complete anything.
    await expect(completeShopifyOAuth({ shop, state: "nope", code: "mock" })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await expect(
      completeShopifyOAuth({ shop: shopDomain(), state: pendingA.state, code: "mock" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const done = await completeShopifyOAuth({ shop, state: pendingA.state, code: "mock" });
    expect(done.companyId).toBe(a.companyId);
    // B's older pending install can no longer claim the store, nor can a new one.
    await expect(
      completeShopifyOAuth({ shop, state: pendingB.state, code: "mock" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(start(b, shop)).rejects.toMatchObject({ code: "ALREADY_CONNECTED" });

    const w = webhook(shop, "orders/cancelled", { id: 2 });
    const res = await processWebhook("shopify", w.headers, w.body);
    expect(res).toMatchObject({ handled: true });
    const rows = await withSystem((tx) =>
      tx.select().from(channelConnections).where(eq(channelConnections.externalShopId, shop)),
    );
    expect(rows.map((r) => [r.companyId, r.status])).toEqual([[a.companyId, "connected"]]);
    expect(rows[0]?.lastWebhookAt).not.toBeNull();
  });

  it("the database allows one connected company per store", async () => {
    const shop = shopDomain();
    const pending = await start(a, shop);
    await completeShopifyOAuth({ shop, state: pending.state, code: "mock" });
    await expect(
      withTenant(b.companyId, (tx) =>
        tx.insert(channelConnections).values({
          companyId: b.companyId,
          channel: "shopify",
          name: "dup",
          status: "connected",
          mode: "api",
          externalShopId: shop,
        }),
      ),
    ).rejects.toSatisfy((err: unknown) =>
      /channel_connections_connected_shop_uq|duplicate key/.test(
        String((err as { cause?: unknown }).cause ?? err),
      ),
    );
  });
});

describe("regex SKU rules are bounded", () => {
  it("rejects backtracking-prone patterns", () => {
    for (const bad of [
      "(a+)+$",
      "^(\\w*)*x",
      "(a|aa)+",
      "((ab)*)+",
      "(?<design>.+)\\1",
      "(?=a)b",
      `^${"a".repeat(201)}`,
    ]) {
      expect(unsafeRegexReason(bad), bad).not.toBeNull();
      expect(() => compilePattern("regex", bad), bad).toThrow();
    }
    for (const ok of [
      "^(?<design>[A-Z0-9]+)-(?<style>\\d+)-(?<color>[A-Z]+)-(?<size>S|M|L|XL)$",
      "^DB-(?<design>\\w+)_(?<size>[a-z]{1,3})$",
      "^(?:TEE)?-(?<design>[^-]+)$",
    ])
      expect(unsafeRegexReason(ok), ok).toBeNull();
  });

  it("never runs a pattern over an overlong SKU", () => {
    const re = compilePattern("regex", "^(?<design>[A-Z]+)$");
    expect(execSku(re, "A".repeat(MAX_SKU_MATCH_LEN))).not.toBeNull();
    expect(execSku(re, "A".repeat(MAX_SKU_MATCH_LEN + 1))).toBeNull();
    const started = Date.now();
    expect(captureFields("template", "{design}{any}{size}", `${"x".repeat(5000)}!`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });
});
