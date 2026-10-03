import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelConn } from "../types";
import { resetShopifyThrottle, setShopifySleep } from "./client";
import { shopifyLive } from "./live";

// Security-reviewer suite for the Shopify adapter (T-27-4 co-review).
const conn: ChannelConn = {
  id: "00000000-0000-4000-8000-000000000021",
  companyId: "00000000-0000-4000-8000-000000000022",
  channel: "shopify",
  name: "Test",
  mode: "api",
  provider: "live",
  externalShopId: "s52-test.myshopify.com",
  cursor: null,
  credentials: { accessToken: "shpat_test", scopes: ["write_products"] },
};
const PRODUCT = "gid://shopify/Product/8100000052";
const FILE = "5b0c1f4e-2222-4a2b-9c3d-000000000001.jpg";

describe("S-52: product image push is not repeated by the client's 5xx retry", () => {
  beforeEach(() => {
    resetShopifyThrottle();
    setShopifySleep(async () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  // Shopify applies productUpdate, then a gateway answers 502. The client re-sends the mutation
  // without the read-back, so the product gets the photo twice. Remove `.fails` once fixed.
  it("a 502 after the mutation was applied does not send productUpdate again", async () => {
    const stored: { id: string; alt: string; status: string; mediaContentType: string }[] = [];
    let mutations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const { query } = JSON.parse(String(init.body)) as { query: string };
        const product = () => ({ id: PRODUCT, media: { nodes: [...stored] } });
        if (!query.includes("productUpdate"))
          return Response.json({ data: { product: product() } });
        mutations++;
        stored.push({
          id: `gid://shopify/MediaImage/${mutations}`,
          alt: "x",
          status: "PROCESSING",
          mediaContentType: "IMAGE",
        });
        if (mutations === 1) return new Response("bad gateway", { status: 502 });
        return Response.json({ data: { productUpdate: { product: product(), userErrors: [] } } });
      }),
    );
    await shopifyLive
      .pushProductImages?.(conn, {
        productGid: PRODUCT,
        images: [
          {
            url: `https://b.s3.amazonaws.com/c/${FILE}?X-Amz-Signature=a`,
            alt: "Front",
            filename: FILE,
          },
        ],
        idempotencyKey: "s52",
      })
      .catch(() => undefined);
    expect(mutations).toBe(1);
    expect(stored).toHaveLength(1);
  });
});
