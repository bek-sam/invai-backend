import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { amazonAdapter } from "../amazon";
import { etsyAdapter } from "../etsy";
import { tiktokAdapter } from "../tiktok";
import { type ChannelConn, ProductImagePushError, type PushProductImagesInput } from "../types";
import { walmartAdapter } from "../walmart";
import { resetShopifyThrottle, setShopifySleep } from "./client";
import { shopifyLive } from "./live";
import { shopifyUrlHasFile } from "./media";
import {
  MOCK_SHOPIFY_MISSING_PRODUCT,
  mockShopifyProductMedia,
  resetMockShopifyMedia,
  shopifyMock,
} from "./mock";

const conn: ChannelConn = {
  id: "00000000-0000-4000-8000-000000000011",
  companyId: "00000000-0000-4000-8000-000000000012",
  channel: "shopify",
  name: "Test",
  mode: "api",
  provider: "live",
  externalShopId: "t274-test.myshopify.com",
  cursor: null,
  credentials: { accessToken: "shpat_test", scopes: ["read_products", "write_products"] },
};

const PRODUCT = "gid://shopify/Product/8100000042";
const IMG_A = "5b0c1f4e-1111-4a2b-9c3d-000000000001.jpg";
const IMG_B = "5b0c1f4e-1111-4a2b-9c3d-000000000002.png";
const url = (f: string) =>
  `https://invai-photos.s3.amazonaws.com/c1/photos/${f}?X-Amz-Signature=abc`;

const input = (over: Partial<PushProductImagesInput> = {}): PushProductImagesInput => ({
  productGid: PRODUCT,
  images: [
    { url: url(IMG_A), alt: "Desert Sun tee, front, on a white background", filename: IMG_A },
    { url: url(IMG_B), alt: "Desert Sun tee, lifestyle", filename: IMG_B },
  ],
  idempotencyKey: "push-1",
  ...over,
});

type Call = { query: string; variables: Record<string, unknown> };

/** A fetch stub answering Shopify GraphQL, recording each request body. */
function stubShopify(handler: (call: Call, n: number) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as Call;
    calls.push(call);
    const r = handler(call, calls.length);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

type Node = { id: string; alt: string | null; status: string; url?: string | null };
const node = (n: Node) => ({
  id: n.id,
  alt: n.alt,
  status: n.status,
  mediaContentType: "IMAGE",
  image: n.url ? { url: n.url } : null,
});
const mediaRead = (nodes: Node[]) => ({
  body: { data: { product: { id: PRODUCT, media: { nodes: nodes.map(node) } } } },
});
const updateOk = (nodes: Node[]) => ({
  body: {
    data: {
      productUpdate: {
        product: { id: PRODUCT, media: { nodes: nodes.map(node) } },
        userErrors: [],
      },
    },
  },
});
const isUpdate = (c: Call) => c.query.includes("productUpdate");

async function rejection(p: Promise<unknown>): Promise<ProductImagePushError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProductImagePushError);
  return err as ProductImagePushError;
}

describe("Shopify pushProductImages (productUpdate media, API 2026-07)", () => {
  beforeEach(() => resetShopifyThrottle());
  afterEach(() => vi.unstubAllGlobals());

  it("reads the product's media, adds the images with alt text and returns their media ids", async () => {
    const old: Node = {
      id: "gid://shopify/MediaImage/1",
      alt: "old",
      status: "READY",
      url: "https://cdn.shopify.com/s/files/1/0001/files/old.jpg?v=1",
    };
    const { calls } = stubShopify((c) =>
      isUpdate(c)
        ? updateOk([
            old,
            {
              id: "gid://shopify/MediaImage/21",
              alt: input().images[0]?.alt ?? "",
              status: "UPLOADED",
            },
            {
              id: "gid://shopify/MediaImage/22",
              alt: input().images[1]?.alt ?? "",
              status: "UPLOADED",
            },
          ])
        : mediaRead([old]),
    );
    const res = await shopifyLive.pushProductImages?.(conn, input());
    expect(res).toEqual({
      pushed: [
        { filename: IMG_A, mediaId: "gid://shopify/MediaImage/21" },
        { filename: IMG_B, mediaId: "gid://shopify/MediaImage/22" },
      ],
      skipped: [],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.variables).toEqual({ id: PRODUCT });
    const update = calls[1];
    expect(update?.query).toContain("productUpdate(product: $product, media: $media)");
    expect(update?.query).not.toContain("productCreateMedia");
    expect(update?.variables).toEqual({
      product: { id: PRODUCT },
      media: [
        { originalSource: url(IMG_A), alt: input().images[0]?.alt, mediaContentType: "IMAGE" },
        { originalSource: url(IMG_B), alt: input().images[1]?.alt, mediaContentType: "IMAGE" },
      ],
    });
  });

  it("retry after a lost answer: images already on the product are skipped, nothing is re-added", async () => {
    const { calls } = stubShopify(() =>
      mediaRead([
        // Processed: Shopify renamed it with a uuid suffix and re-encoded to webp.
        {
          id: "gid://shopify/MediaImage/31",
          alt: "edited by the shop",
          status: "READY",
          url: `https://cdn.shopify.com/s/files/1/0001/files/${IMG_A.replace(".jpg", "")}_0f8fad5b-d9cb-469f-a165-70867728950e.webp?v=2`,
        },
        // Still processing: no URL yet, the exact alt identifies the earlier attempt.
        {
          id: "gid://shopify/MediaImage/32",
          alt: input().images[1]?.alt ?? "",
          status: "PROCESSING",
        },
      ]),
    );
    const res = await shopifyLive.pushProductImages?.(conn, input());
    expect(res).toEqual({
      pushed: [],
      skipped: [
        { filename: IMG_A, mediaId: "gid://shopify/MediaImage/31", reason: "already_pushed" },
        { filename: IMG_B, mediaId: "gid://shopify/MediaImage/32", reason: "already_pushed" },
      ],
    });
    expect(calls.some(isUpdate)).toBe(false);
  });

  it("a media Shopify failed to download doesn't count: only that image is added again", async () => {
    const { calls } = stubShopify((c) =>
      isUpdate(c)
        ? updateOk([
            {
              id: "gid://shopify/MediaImage/41",
              alt: input().images[0]?.alt ?? "",
              status: "FAILED",
            },
            {
              id: "gid://shopify/MediaImage/42",
              alt: input().images[1]?.alt ?? "",
              status: "READY",
              url: `https://cdn.shopify.com/s/files/1/0001/files/${IMG_B}`,
            },
            {
              id: "gid://shopify/MediaImage/43",
              alt: input().images[0]?.alt ?? "",
              status: "UPLOADED",
            },
          ])
        : mediaRead([
            {
              id: "gid://shopify/MediaImage/41",
              alt: input().images[0]?.alt ?? "",
              status: "FAILED",
            },
            {
              id: "gid://shopify/MediaImage/42",
              alt: input().images[1]?.alt ?? "",
              status: "READY",
              url: `https://cdn.shopify.com/s/files/1/0001/files/${IMG_B}`,
            },
          ]),
    );
    const res = await shopifyLive.pushProductImages?.(conn, input());
    expect(res?.pushed).toEqual([{ filename: IMG_A, mediaId: "gid://shopify/MediaImage/43" }]);
    expect(res?.skipped).toEqual([
      { filename: IMG_B, mediaId: "gid://shopify/MediaImage/42", reason: "already_pushed" },
    ]);
    const media = calls.find(isUpdate)?.variables.media as { originalSource: string }[];
    expect(media.map((m) => m.originalSource)).toEqual([url(IMG_A)]);
  });

  it("missing write_products in the recorded grant: reconnect needed, no call to Shopify", async () => {
    const { fetchMock } = stubShopify(() => mediaRead([]));
    const err = await rejection(
      shopifyLive.pushProductImages?.(
        { ...conn, credentials: { accessToken: "shpat_test", scopes: ["read_products"] } },
        input(),
      ) ?? Promise.resolve(),
    );
    expect(err.code).toBe("reconnect_needed");
    expect(err.message).toMatch(/Reconnect your Shopify store/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Shopify answers ACCESS_DENIED (grant unknown) or 403: reconnect needed", async () => {
    stubShopify(() => ({
      body: {
        errors: [
          {
            message:
              "Access denied for productUpdate field. Required access: `write_products` access scope.",
            extensions: { code: "ACCESS_DENIED" },
          },
        ],
      },
    }));
    const unknownGrant = { ...conn, credentials: { accessToken: "shpat_test" } };
    expect(
      (await rejection(shopifyLive.pushProductImages?.(unknownGrant, input()) ?? Promise.resolve()))
        .code,
    ).toBe("reconnect_needed");
    stubShopify(() => ({ status: 403, body: {} }));
    expect(
      (await rejection(shopifyLive.pushProductImages?.(conn, input()) ?? Promise.resolve())).code,
    ).toBe("reconnect_needed");
  });

  it("unknown product: product_not_found (no product on read; malformed gid never calls)", async () => {
    const { fetchMock } = stubShopify(() => ({ body: { data: { product: null } } }));
    expect(
      (await rejection(shopifyLive.pushProductImages?.(conn, input()) ?? Promise.resolve())).code,
    ).toBe("product_not_found");
    fetchMock.mockClear();
    const bad = input({ productGid: "gid://shopify/ProductVariant/8100000042" });
    expect(
      (await rejection(shopifyLive.pushProductImages?.(conn, bad) ?? Promise.resolve())).code,
    ).toBe("product_not_found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("user errors become a typed rejection with a readable message", async () => {
    stubShopify((c) =>
      isUpdate(c)
        ? {
            body: {
              data: {
                productUpdate: {
                  product: { id: PRODUCT, media: { nodes: [] } },
                  userErrors: [
                    { field: ["media", "0", "originalSource"], message: "Image URL is invalid" },
                  ],
                },
              },
            },
          }
        : mediaRead([]),
    );
    const err = await rejection(
      shopifyLive.pushProductImages?.(conn, input()) ?? Promise.resolve(),
    );
    expect(err.code).toBe("rejected");
    expect(err.outcome).toBe("not_done");
    expect(err.message).toBe("Shopify didn't accept the photos: Image URL is invalid");
  });

  it("throttled: waits for the cost bucket (restore rate) and retries, never a tight loop", async () => {
    const waits: number[] = [];
    const restore = setShopifySleep(async (ms) => {
      waits.push(ms);
    });
    try {
      stubShopify((c, n) =>
        n === 1
          ? {
              body: {
                errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
                extensions: {
                  cost: {
                    requestedQueryCost: 260,
                    throttleStatus: {
                      maximumAvailable: 2000,
                      currentlyAvailable: 60,
                      restoreRate: 100,
                    },
                  },
                },
              },
            }
          : isUpdate(c)
            ? updateOk([
                {
                  id: "gid://shopify/MediaImage/51",
                  alt: input().images[0]?.alt ?? "",
                  status: "UPLOADED",
                },
                {
                  id: "gid://shopify/MediaImage/52",
                  alt: input().images[1]?.alt ?? "",
                  status: "UPLOADED",
                },
              ])
            : mediaRead([]),
      );
      const res = await shopifyLive.pushProductImages?.(conn, input());
      expect(res?.pushed).toHaveLength(2);
      // (260 - 60) points at 100/s = 2 s.
      expect(waits[0]).toBe(2000);
    } finally {
      restore();
    }
  });

  it("refuses bad input before any call: filename must be the URL's last segment, https, unique", async () => {
    const { fetchMock } = stubShopify(() => mediaRead([]));
    const cases: PushProductImagesInput[] = [
      input({ images: [{ url: url("other.jpg"), alt: "x", filename: IMG_A }] }),
      input({ images: [{ url: url(IMG_A).replace("https", "http"), alt: "x", filename: IMG_A }] }),
      input({
        images: [
          { url: url(IMG_A), alt: "x", filename: IMG_A },
          { url: url(IMG_A), alt: "y", filename: IMG_A },
        ],
      }),
      input({ images: [{ url: url("../etc.jpg"), alt: "x", filename: "../etc.jpg" }] }),
      input({ images: [{ url: url(IMG_A), alt: "a".repeat(513), filename: IMG_A }] }),
      input({ idempotencyKey: " " }),
    ];
    for (const c of cases)
      expect(
        (await rejection(shopifyLive.pushProductImages?.(conn, c) ?? Promise.resolve())).code,
      ).toBe("invalid_input");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches Shopify CDN names by stem, with or without the uuid suffix", () => {
    const cdn = "https://cdn.shopify.com/s/files/1/0001/files";
    expect(shopifyUrlHasFile(`${cdn}/${IMG_A}?v=1`, IMG_A)).toBe(true);
    expect(
      shopifyUrlHasFile(
        `${cdn}/${IMG_A.replace(".jpg", "_0f8fad5b-d9cb-469f-a165-70867728950e.jpg")}`,
        IMG_A,
      ),
    ).toBe(true);
    expect(shopifyUrlHasFile(`${cdn}/${IMG_B}`, IMG_A)).toBe(false);
    expect(shopifyUrlHasFile(`${cdn}/x${IMG_A}`, IMG_A)).toBe(false);
  });
});

describe("Shopify mock pushProductImages", () => {
  beforeEach(() => resetMockShopifyMedia());

  it("records images per connection, product and filename; the same key twice skips, no duplicates", async () => {
    const first = await shopifyMock.pushProductImages?.(conn, input());
    expect(first?.pushed.map((p) => p.filename)).toEqual([IMG_A, IMG_B]);
    expect(first?.skipped).toEqual([]);
    const again = await shopifyMock.pushProductImages?.(conn, input());
    expect(again?.pushed).toEqual([]);
    expect(again?.skipped).toEqual(first?.pushed.map((p) => ({ ...p, reason: "already_pushed" })));
    expect(mockShopifyProductMedia(conn.id, PRODUCT)).toHaveLength(2);
    // Another connection has its own store.
    const other = await shopifyMock.pushProductImages?.(
      { ...conn, id: "00000000-0000-4000-8000-000000000099" },
      input(),
    );
    expect(other?.pushed).toHaveLength(2);
  });

  it("unknown product: product_not_found", async () => {
    const err = await rejection(
      shopifyMock.pushProductImages?.(conn, input({ productGid: MOCK_SHOPIFY_MISSING_PRODUCT })) ??
        Promise.resolve(),
    );
    expect(err.code).toBe("product_not_found");
  });

  it("only Shopify implements it", () => {
    for (const a of [
      amazonAdapter,
      tiktokAdapter,
      walmartAdapter,
      etsyAdapter("mock"),
      etsyAdapter("live"),
    ])
      expect(a.pushProductImages).toBeUndefined();
  });
});
