import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelConn } from "../types";
import { shopifyLive } from "./live";
import { shopifyMock } from "./mock";

const conn: ChannelConn = {
  id: "00000000-0000-4000-8000-000000000001",
  companyId: "00000000-0000-4000-8000-000000000002",
  channel: "shopify",
  name: "Test",
  mode: "api",
  provider: "live",
  externalShopId: "t31-test.myshopify.com",
  cursor: null,
  credentials: { accessToken: "shpat_test", locationId: "gid://shopify/Location/1" },
};

type Call = { query: string; variables: Record<string, unknown> };

/** A fetch stub answering Shopify GraphQL by operation, recording each call. */
function stubShopify(handler: (call: Call, n: number) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)) as Call;
      calls.push(call);
      return new Response(JSON.stringify(handler(call, calls.length)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const level = (sku: string, item: number, available: number | null) => ({
  sku,
  inventoryItem: {
    id: `gid://shopify/InventoryItem/${item}`,
    inventoryLevel:
      available === null ? null : { quantities: [{ name: "available", quantity: available }] },
  },
});

const setOk = { data: { inventorySetQuantities: { userErrors: [] } } };
const setStale = {
  data: {
    inventorySetQuantities: {
      userErrors: [
        {
          field: ["input", "quantities", "0", "changeFromQuantity"],
          message: "The changeFromQuantity value does not match persisted value.",
          code: "CHANGE_FROM_QUANTITY_STALE",
        },
      ],
    },
  },
};

describe("Shopify setAvailability (inventorySetQuantities, API 2026-07)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends changeFromQuantity from a fresh read and an @idempotent key, never ignoreCompareQuantity", async () => {
    const calls = stubShopify((c) =>
      c.query.includes("productVariants")
        ? {
            data: {
              productVariants: { nodes: [level("TEE-BLK-M", 11, 7), level("TEE-BLK-MX", 99, 1)] },
            },
          }
        : setOk,
    );
    const res = await shopifyLive.setAvailability(
      conn,
      [{ listingVariantId: "lv-1", channelSku: "TEE-BLK-M", available: 4 }],
      { idempotencyKey: "push-key-1" },
    );
    expect(res).toEqual({
      updated: 1,
      results: [{ listingVariantId: "lv-1", status: "set", available: 4, message: null }],
    });
    const set = calls.find((c) => c.query.includes("inventorySetQuantities"));
    expect(set?.query).toContain("@idempotent(key: $idempotencyKey)");
    expect(set?.query).not.toContain("ignoreCompareQuantity");
    expect(set?.variables.idempotencyKey).toBe("push-key-1");
    const input = set?.variables.input as { quantities: Record<string, unknown>[] };
    expect(JSON.stringify(input)).not.toContain('compareQuantity"');
    // The fuzzy search also matched TEE-BLK-MX; only the exact SKU is written.
    expect(input.quantities).toEqual([
      {
        inventoryItemId: "gid://shopify/InventoryItem/11",
        locationId: "gid://shopify/Location/1",
        quantity: 4,
        changeFromQuantity: 7,
      },
    ]);
  });

  it("on a stale compare re-reads and retries once with fresh data and a new key", async () => {
    let reads = 0;
    const calls = stubShopify((c) => {
      if (c.query.includes("productVariants")) {
        reads++;
        // A Shopify sale lands between our read and our write: 7 becomes 6.
        return { data: { productVariants: { nodes: [level("TEE-1", 11, reads === 1 ? 7 : 6)] } } };
      }
      return calls.filter((x) => x.query.includes("inventorySetQuantities")).length === 1
        ? setStale
        : setOk;
    });
    const res = await shopifyLive.setAvailability(
      conn,
      [{ listingVariantId: "lv-1", channelSku: "TEE-1", available: 3 }],
      { idempotencyKey: "k" },
    );
    expect(res.results?.[0]).toMatchObject({ status: "set", available: 3 });
    const sets = calls.filter((c) => c.query.includes("inventorySetQuantities"));
    expect(sets).toHaveLength(2);
    const q = (i: number) =>
      (sets[i]?.variables.input as { quantities: { changeFromQuantity: number }[] } | undefined)
        ?.quantities[0];
    expect(q(0)?.changeFromQuantity).toBe(7);
    expect(q(1)?.changeFromQuantity).toBe(6);
    expect(sets[0]?.variables.idempotencyKey).toBe("k");
    expect(sets[1]?.variables.idempotencyKey).toBe("k:retry");
  });

  it("a second mismatch fails the item instead of looping", async () => {
    let reads = 0;
    const calls = stubShopify((c) =>
      c.query.includes("productVariants")
        ? { data: { productVariants: { nodes: [level("TEE-1", 11, 10 - ++reads)] } } }
        : setStale,
    );
    const res = await shopifyLive.setAvailability(conn, [
      { listingVariantId: "lv-1", channelSku: "TEE-1", available: 3 },
    ]);
    expect(res.updated).toBe(0);
    expect(res.results?.[0]).toMatchObject({ status: "failed", available: null });
    expect(calls.filter((c) => c.query.includes("inventorySetQuantities"))).toHaveLength(2);
  });

  it("reports unknown and unstocked SKUs, skips unchanged values, and batches the lookup", async () => {
    const calls = stubShopify((c) => {
      if (c.query.includes("productVariants")) {
        expect(c.variables.query).toBe('sku:"A" OR sku:"B" OR sku:"C"');
        return { data: { productVariants: { nodes: [level("A", 1, 5), level("B", 2, null)] } } };
      }
      return setOk;
    });
    const res = await shopifyLive.setAvailability(conn, [
      { listingVariantId: "a", channelSku: "A", available: 5 },
      { listingVariantId: "b", channelSku: "B", available: 2 },
      { listingVariantId: "c", channelSku: "C", available: 2 },
      { listingVariantId: "d", channelSku: " ", available: 2 },
    ]);
    expect(res.results?.map((r) => [r.listingVariantId, r.status])).toEqual([
      ["a", "set"],
      ["b", "not_found"],
      ["c", "not_found"],
      ["d", "not_found"],
    ]);
    // A is already 5 on Shopify: no write at all.
    expect(calls.filter((c) => c.query.includes("inventorySetQuantities"))).toHaveLength(0);
  });

  it("still accepts the pre-wave-3 { channelSku, quantity } shape", async () => {
    stubShopify((c) =>
      c.query.includes("productVariants")
        ? { data: { productVariants: { nodes: [level("A", 1, 0)] } } }
        : setOk,
    );
    const res = await shopifyLive.setAvailability(conn, [{ channelSku: "A", quantity: -2 }]);
    expect(res.results?.[0]).toMatchObject({ listingVariantId: "A", status: "set", available: 0 });
  });

  it("the mock store reports every item as set", async () => {
    const res = await shopifyMock.setAvailability({ ...conn, provider: "mock" }, [
      { listingVariantId: "lv-9", channelSku: "X", available: 12 },
    ]);
    expect(res).toEqual({
      updated: 1,
      results: [{ listingVariantId: "lv-9", status: "set", available: 12, message: null }],
    });
  });
});
