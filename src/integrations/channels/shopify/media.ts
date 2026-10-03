import { createHash } from "node:crypto";
import { isORPCError } from "../../../lib/errors";
import { logger } from "../../../lib/log";
import {
  type ChannelConn,
  type ProductImage,
  ProductImagePushError,
  type PushProductImagesInput,
  type PushProductImagesResult,
} from "../types";
import { ShopifyAuthError, shopifyGraphql } from "./client";

const log = logger("channels.shopify.media");

/*
 * Product image push (T-27-4), Admin GraphQL 2026-07 (SHOPIFY_API_VERSION).
 * - https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/productUpdate
 *   (`media: [CreateMediaInput!]` adds media; scope `write_products`)
 * - https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/CreateMediaInput
 *   (`originalSource` external URL, `alt`, `mediaContentType`; no filename field: Shopify takes
 *   the filename from the URL's last path segment)
 * - https://shopify.dev/docs/api/admin-graphql/2026-07/objects/MediaImage
 *   (`image` is null until processing ends; `status` UPLOADED/PROCESSING/READY/FAILED)
 * - https://shopify.dev/docs/apps/build/product-merchandising/products-and-collections/manage-media
 * `productCreateMedia` is deprecated; `productUpdate` has no `@idempotent` directive. Dedupe is a
 * read-back: before adding, the product's media are read and any image already there is skipped
 * (by filename once Shopify has processed it, by alt marker while it is still processing). While
 * a media is processing, `image` is null and the MediaImage docs promise no other per-file field
 * (`originalSource` is not documented as readable then), and every image of a photo set shares
 * one alt text, so the alt we send ends in a marker derived from the filename stem
 * (`altMarker`), which Shopify stores as given. Each existing media matches at most one image. A
 * failed media (Shopify could not download it) does not count as pushed. A product holds at most
 * 250 media, so `media(first: 250)` reads all of them.
 */

export const SHOPIFY_IMAGE_SCOPE = "write_products";
const MAX_MEDIA = 250;
const MAX_ALT = 512;
const MAX_IMAGES_PER_PUSH = 50;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}\.(jpe?g|png|webp)$/i;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/([1-9]\d{0,19})$/;

const MEDIA_FIELDS = /* GraphQL */ `
  fragment InvaiMedia on Media {
    id
    alt
    status
    mediaContentType
    ... on MediaImage { image { url } }
  }
`;

const PRODUCT_MEDIA = /* GraphQL */ `
  query InvaiProductMedia($id: ID!) {
    product(id: $id) { id media(first: 250) { nodes { ...InvaiMedia } } }
  }
  ${MEDIA_FIELDS}
`;

const PRODUCT_ADD_MEDIA = /* GraphQL */ `
  mutation InvaiProductAddMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
    productUpdate(product: $product, media: $media) {
      product { id media(first: 250) { nodes { ...InvaiMedia } } }
      userErrors { field message }
    }
  }
  ${MEDIA_FIELDS}
`;

type MediaNode = {
  id: string;
  alt: string | null;
  status: string;
  mediaContentType: string;
  image?: { url: string } | null;
};

const msg = {
  notFound: "This Shopify product no longer exists. Re-sync your Shopify listings and try again.",
  reconnect:
    "Reconnect your Shopify store to allow photo uploads. InvAI now needs permission to edit products.",
  full: "This Shopify product already has 250 photos and videos, Shopify's limit. Remove some and try again.",
};

/** The numeric product id, or null when the gid is not a Shopify product gid. */
export function shopifyProductId(productGid: string): string | null {
  return PRODUCT_GID.exec(productGid)?.[1] ?? null;
}

function basename(path: string): string {
  const last = path.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Checks the input both adapters share; throws `invalid_input` / `product_not_found`. */
export function validateProductImages(input: PushProductImagesInput): string {
  const id = shopifyProductId(input.productGid);
  if (!id) throw new ProductImagePushError("product_not_found", msg.notFound);
  if (!input.idempotencyKey.trim())
    throw new ProductImagePushError("invalid_input", "A push needs an idempotency key");
  if (input.images.length > MAX_IMAGES_PER_PUSH)
    throw new ProductImagePushError(
      "invalid_input",
      `Push at most ${MAX_IMAGES_PER_PUSH} photos at once`,
    );
  const seen = new Set<string>();
  for (const img of input.images) {
    if (!FILENAME.test(img.filename))
      throw new ProductImagePushError(
        "invalid_input",
        `Photo file name not allowed: ${img.filename}`,
      );
    const key = img.filename.toLowerCase();
    if (seen.has(key))
      throw new ProductImagePushError("invalid_input", `Photo listed twice: ${img.filename}`);
    seen.add(key);
    if (img.alt.length > MAX_ALT)
      throw new ProductImagePushError(
        "invalid_input",
        `Photo description is over ${MAX_ALT} characters`,
      );
    let url: URL;
    try {
      url = new URL(img.url);
    } catch {
      throw new ProductImagePushError("invalid_input", `Photo link is not valid: ${img.filename}`);
    }
    // Shopify names the file after the URL's last segment, and dedupe matches on that name.
    if (url.protocol !== "https:" || basename(url.pathname) !== img.filename)
      throw new ProductImagePushError(
        "invalid_input",
        `Photo link must be https and end in ${img.filename}`,
      );
  }
  return id;
}

const stem = (filename: string) => filename.replace(/\.[^.]+$/, "").toLowerCase();
const UUID_SUFFIX = /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Does a Shopify CDN URL hold this file? Shopify may append `_<uuid>` to a taken name and may
 * re-encode the format, so the stem decides (our filenames are unique ids per image).
 */
export function shopifyUrlHasFile(cdnUrl: string, filename: string): boolean {
  let path: string;
  try {
    path = new URL(cdnUrl).pathname;
  } catch {
    return false;
  }
  const got = stem(basename(path)).replace(UUID_SUFFIX, "");
  return got === stem(filename);
}

/** Short per-image marker from the filename stem, e.g. `[img a1b2c3d4]`; not a secret. */
export function altMarker(filename: string): string {
  return `[img ${createHash("sha256").update(stem(filename)).digest("hex").slice(0, 8)}]`;
}

/** The alt sent to Shopify: the shop's alt (cut to fit) followed by the image's marker. */
export function shopifyAlt(img: ProductImage): string {
  const marker = altMarker(img.filename);
  const base = img.alt
    .trim()
    .slice(0, MAX_ALT - marker.length - 1)
    .trimEnd();
  return base ? `${base} ${marker}` : marker;
}

const hasMarker = (n: MediaNode, img: ProductImage) =>
  (n.alt ?? "").endsWith(altMarker(img.filename));

/** The existing media node that already holds this image, if any and not already claimed. */
function findExisting(
  nodes: MediaNode[],
  img: ProductImage,
  claimed: Set<string>,
): MediaNode | undefined {
  const live = nodes.filter(
    (n) => n.status !== "FAILED" && n.mediaContentType === "IMAGE" && !claimed.has(n.id),
  );
  return (
    live.find((n) => n.image?.url && shopifyUrlHasFile(n.image.url, img.filename)) ??
    // Still processing (no URL yet): only this image's marker identifies the earlier attempt.
    live.find((n) => !n.image?.url && hasMarker(n, img))
  );
}

/** Missing scope or refused token: the shop must reconnect (re-consent). */
function reconnectError(err: unknown): ProductImagePushError | null {
  if (err instanceof ShopifyAuthError)
    return new ProductImagePushError("reconnect_needed", msg.reconnect);
  if (isORPCError(err) && err.code === "UPSTREAM_FAILED") {
    const detail = (err.data as { detail?: string | null } | undefined)?.detail ?? "";
    if (/access denied|write_products|ACCESS_DENIED/i.test(detail))
      return new ProductImagePushError("reconnect_needed", msg.reconnect);
  }
  return null;
}

async function readMedia(conn: ChannelConn, productGid: string): Promise<MediaNode[]> {
  const data = await shopifyGraphql<{ product: { media: { nodes: MediaNode[] } } | null }>(
    conn,
    PRODUCT_MEDIA,
    { id: productGid },
    { cost: 260 },
  );
  if (!data.product) throw new ProductImagePushError("product_not_found", msg.notFound);
  return data.product.media.nodes;
}

export async function pushShopifyProductImages(
  conn: ChannelConn,
  input: PushProductImagesInput,
): Promise<PushProductImagesResult> {
  validateProductImages(input);
  const scopes = conn.credentials?.scopes;
  // Scopes recorded at install: refuse before calling when the grant lacks product writes. An
  // empty or missing list is unknown; Shopify's ACCESS_DENIED then maps to the same error.
  if (scopes?.length && !scopes.includes(SHOPIFY_IMAGE_SCOPE))
    throw new ProductImagePushError("reconnect_needed", msg.reconnect);
  try {
    return await push(conn, input);
  } catch (err) {
    const reconnect = reconnectError(err);
    if (reconnect) {
      log.warn("shopify refused the image push; reconnect needed", { connectionId: conn.id });
      throw reconnect;
    }
    throw err;
  }
}

async function push(
  conn: ChannelConn,
  input: PushProductImagesInput,
): Promise<PushProductImagesResult> {
  const before = await readMedia(conn, input.productGid);
  const skipped: PushProductImagesResult["skipped"] = [];
  const todo: ProductImage[] = [];
  const claimed = new Set<string>();
  for (const img of input.images) {
    const found = findExisting(before, img, claimed);
    if (found) {
      claimed.add(found.id);
      skipped.push({ filename: img.filename, mediaId: found.id, reason: "already_pushed" });
    } else todo.push(img);
  }
  if (todo.length === 0) return { pushed: [], skipped };
  if (before.length + todo.length > MAX_MEDIA)
    throw new ProductImagePushError("rejected", msg.full);

  const res = await shopifyGraphql<{
    productUpdate: {
      product: { media: { nodes: MediaNode[] } } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(
    conn,
    PRODUCT_ADD_MEDIA,
    {
      product: { id: input.productGid },
      media: todo.map((img) => ({
        originalSource: img.url,
        alt: shopifyAlt(img),
        mediaContentType: "IMAGE",
      })),
    },
    // No 5xx retry: the mutation may already be applied; the caller's retry reads media first (S-52).
    { cost: 270, retryServerErrors: false },
  );
  const { product, userErrors } = res.productUpdate;
  const beforeIds = new Set(before.map((n) => n.id));
  const added = (product?.media.nodes ?? []).filter((n) => !beforeIds.has(n.id));
  if (userErrors.length) {
    log.warn("shopify rejected the image push", {
      connectionId: conn.id,
      idempotencyKey: input.idempotencyKey,
      fields: userErrors.map((e) => (e.field ?? []).join(".")),
      added: added.length,
    });
    if (!product && userErrors.some((e) => (e.field ?? []).includes("id")))
      throw new ProductImagePushError("product_not_found", msg.notFound);
    throw new ProductImagePushError(
      "rejected",
      `Shopify didn't accept the photos: ${userErrors.map((e) => e.message).join("; ")}`,
      added.length > 0 ? "partial" : "not_done",
    );
  }

  // New media come back in input order; filename and marker are checked first in case they don't.
  const free = [...added];
  const pushed: PushProductImagesResult["pushed"] = [];
  for (const img of todo) {
    const i = free.findIndex(
      (n) => (n.image?.url && shopifyUrlHasFile(n.image.url, img.filename)) || hasMarker(n, img),
    );
    const node = i >= 0 ? free.splice(i, 1)[0] : free.shift();
    if (!node)
      throw new ProductImagePushError(
        "rejected",
        "Shopify didn't add every photo. Try the push again.",
        added.length > 0 ? "partial" : "not_done",
      );
    pushed.push({ filename: img.filename, mediaId: node.id });
  }
  log.info("shopify product images pushed", {
    connectionId: conn.id,
    idempotencyKey: input.idempotencyKey,
    pushed: pushed.length,
    skipped: skipped.length,
  });
  return { pushed, skipped };
}
