import { randomUUID } from "node:crypto";
import { upstream } from "../../../lib/errors";
import { logger } from "../../../lib/log";
import type {
  AvailabilityItemResult,
  AvailabilityUpdate,
  ChannelConn,
  SetAvailabilityOptions,
  SetAvailabilityResult,
} from "../types";
import { shopifyGraphql } from "./client";

const log = logger("channels.shopify.inventory");

/*
 * Availability push (Admin GraphQL 2026-07, `inventorySetQuantities`).
 * - https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/inventorySetQuantities
 * - https://shopify.dev/changelog/finalizing-compare-and-swap-redesign-for-inventory-set-quantities
 *   (`compareQuantity`/`ignoreCompareQuantity` removed; `changeFromQuantity` per quantity)
 * - https://shopify.dev/changelog/making-idempotency-mandatory-for-inventory-adjustments-and-refund-mutations
 *   (`@idempotent(key:)` checked at runtime)
 * Error codes: https://shopify.dev/docs/api/admin-graphql/latest/enums/InventorySetQuantitiesUserErrorCode
 *
 * Compare-and-set: each quantity carries `changeFromQuantity` = the `available` value read just
 * before the write. If something else changed it in between (CHANGE_FROM_QUANTITY_STALE), the
 * levels are read again and the write is retried once with a new key; a second mismatch fails.
 */

/** Shopify caps input arrays at 250; SKU lookups stay well under the search query length. */
const SET_BATCH = 250;
const LOOKUP_BATCH = 50;

const LOCATIONS_QUERY = /* GraphQL */ `
  query { locations(first: 1, query: "active:true") { nodes { id } } }
`;

/** Variants by SKU with the inventory item and its current `available` at one location. */
const VARIANTS_BY_SKU = /* GraphQL */ `
  query VariantsBySku($query: String!, $first: Int!, $locationId: ID!) {
    productVariants(first: $first, query: $query) {
      nodes {
        sku
        inventoryItem {
          id
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  }
`;

const INVENTORY_SET = /* GraphQL */ `
  mutation InventorySet($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }
`;

type VariantNode = {
  sku: string | null;
  inventoryItem: {
    id: string;
    inventoryLevel: { quantities: { name: string; quantity: number }[] } | null;
  } | null;
};

type UserError = { field: string[] | null; message: string; code: string | null };

/** One inventory item to set: which listing variants it serves and what Shopify holds now. */
type Target = { inventoryItemId: string; current: number; available: number; ids: string[] };

const skuQuery = (skus: string[]) => skus.map((s) => `sku:${JSON.stringify(s)}`).join(" OR ");

async function resolveLocation(conn: ChannelConn): Promise<string> {
  if (conn.credentials?.locationId) return conn.credentials.locationId;
  const loc = await shopifyGraphql<{ locations: { nodes: { id: string }[] } }>(
    conn,
    LOCATIONS_QUERY,
  );
  const id = loc.locations.nodes[0]?.id;
  if (!id) throw upstream("Shopify", "store has no active location");
  return id;
}

/** Current `available` per inventory item for these SKUs (exact SKU match; null = not stocked). */
async function readLevels(conn: ChannelConn, skus: string[], locationId: string) {
  const bySku = new Map<string, { inventoryItemId: string; current: number | null }[]>();
  for (let i = 0; i < skus.length; i += LOOKUP_BATCH) {
    const chunk = skus.slice(i, i + LOOKUP_BATCH);
    const data = await shopifyGraphql<{ productVariants: { nodes: VariantNode[] } }>(
      conn,
      VARIANTS_BY_SKU,
      { query: skuQuery(chunk), first: 250, locationId },
    );
    for (const v of data.productVariants.nodes) {
      // Shopify's search is not exact (prefixes, tokens): keep only the SKU we asked for.
      if (!v.sku || !chunk.includes(v.sku) || !v.inventoryItem) continue;
      const level = v.inventoryItem.inventoryLevel;
      const current = level
        ? (level.quantities.find((q) => q.name === "available")?.quantity ?? 0)
        : null;
      const list = bySku.get(v.sku) ?? [];
      list.push({ inventoryItemId: v.inventoryItem.id, current });
      bySku.set(v.sku, list);
    }
  }
  return bySku;
}

async function writeQuantities(
  conn: ChannelConn,
  targets: Target[],
  locationId: string,
  idempotencyKey: string,
): Promise<UserError[]> {
  const res = await shopifyGraphql<{
    inventorySetQuantities: { userErrors: UserError[] };
  }>(conn, INVENTORY_SET, {
    idempotencyKey,
    input: {
      name: "available",
      reason: "correction",
      referenceDocumentUri: `gid://invai/AvailabilityPush/${idempotencyKey}`,
      quantities: targets.map((t) => ({
        inventoryItemId: t.inventoryItemId,
        locationId,
        quantity: t.available,
        changeFromQuantity: t.current,
      })),
    },
  });
  return res.inventorySetQuantities.userErrors;
}

/** A second key for the one retry: a new attempt with new parameters needs its own key. */
const retryKey = (key: string) => `${key}:retry`;

const isStale = (errors: UserError[]) =>
  errors.length > 0 && errors.every((e) => e.code === "CHANGE_FROM_QUANTITY_STALE");

export async function setShopifyAvailability(
  conn: ChannelConn,
  updates: AvailabilityUpdate[],
  opts: SetAvailabilityOptions = {},
): Promise<SetAvailabilityResult> {
  const results = new Map<string, AvailabilityItemResult>();
  const wanted = updates.filter((u) => u.channelSku.trim() !== "");
  for (const u of updates)
    if (!wanted.includes(u))
      results.set(u.listingVariantId, {
        listingVariantId: u.listingVariantId,
        status: "not_found",
        available: null,
        message: "No SKU",
      });
  if (wanted.length === 0) return { updated: 0, results: [...results.values()] };

  const locationId = await resolveLocation(conn);
  const skus = [...new Set(wanted.map((u) => u.channelSku))];
  const baseKey = opts.idempotencyKey ?? randomUUID();

  const plan = (levels: Awaited<ReturnType<typeof readLevels>>) => {
    const byItem = new Map<string, Target>();
    for (const u of wanted) {
      const found = (levels.get(u.channelSku) ?? []).filter((l) => l.current !== null);
      if (found.length === 0) {
        results.set(u.listingVariantId, {
          listingVariantId: u.listingVariantId,
          status: "not_found",
          available: null,
          message: levels.has(u.channelSku)
            ? "Not stocked at the Shopify location"
            : `No Shopify variant with SKU ${u.channelSku}`,
        });
        continue;
      }
      for (const l of found) {
        // Two listing variants on one inventory item: the last value wins, both are reported.
        const t = byItem.get(l.inventoryItemId) ?? {
          inventoryItemId: l.inventoryItemId,
          current: l.current as number,
          available: 0,
          ids: [],
        };
        t.available = Math.max(0, Math.trunc(u.available));
        if (!t.ids.includes(u.listingVariantId)) t.ids.push(u.listingVariantId);
        byItem.set(l.inventoryItemId, t);
      }
    }
    return [...byItem.values()];
  };

  const mark = (targets: Target[], status: "set" | "failed", message: string | null) => {
    for (const t of targets)
      for (const id of t.ids)
        results.set(id, {
          listingVariantId: id,
          status,
          available: status === "set" ? t.available : null,
          message,
        });
  };

  const all = plan(await readLevels(conn, skus, locationId));
  for (let i = 0; i < all.length; i += SET_BATCH) {
    const batch = all.slice(i, i + SET_BATCH);
    const key = i === 0 ? baseKey : `${baseKey}:${i / SET_BATCH}`;
    // Nothing to change: skip the write (Shopify would record an empty adjustment).
    const changed = batch.filter((t) => t.current !== t.available);
    mark(
      batch.filter((t) => t.current === t.available),
      "set",
      null,
    );
    if (changed.length === 0) continue;
    let errors = await writeQuantities(conn, changed, locationId, key);
    let final = changed;
    if (isStale(errors)) {
      log.info("availability changed on Shopify during the push; re-reading once", {
        connectionId: conn.id,
        items: changed.length,
      });
      const ids = new Set(changed.flatMap((t) => t.ids));
      const again = wanted.filter((u) => ids.has(u.listingVariantId));
      const fresh = plan(
        await readLevels(conn, [...new Set(again.map((u) => u.channelSku))], locationId),
      ).filter((t) => changed.some((c) => c.inventoryItemId === t.inventoryItemId));
      mark(
        fresh.filter((t) => t.current === t.available),
        "set",
        null,
      );
      final = fresh.filter((t) => t.current !== t.available);
      errors = final.length ? await writeQuantities(conn, final, locationId, retryKey(key)) : [];
    }
    if (errors.length) {
      const message = errors.map((e) => e.message).join("; ");
      log.warn("availability push rejected", {
        connectionId: conn.id,
        codes: [...new Set(errors.map((e) => e.code))],
      });
      mark(final, "failed", message);
    } else mark(final, "set", null);
  }

  const list = updates.map(
    (u) =>
      results.get(u.listingVariantId) ?? {
        listingVariantId: u.listingVariantId,
        status: "failed" as const,
        available: null,
        message: "Not processed",
      },
  );
  return { updated: list.filter((r) => r.status === "set").length, results: list };
}
