import type { Channel, SkuRuleInput as SkuRuleInputSchema } from "@invai/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import { blankVariants, designFiles, designs, orderItems, orders, products } from "../../db/schema";
import { audit } from "../../lib/audit";
import { conflict, notFound } from "../../lib/errors";
import { emit } from "../../lib/outbox";
import { createRule, loadMatcher, type Matcher, recordRuleUse } from "../channels/sku";
import { releaseForItems, reserveForItems } from "../inventory/service";
import { renderItemArtwork } from "../personalization/service";
import { withFlags } from "./flags";
import { getItem, getItemRow } from "./service";
import { transitionItem } from "./state-machine";

/*
 * Applying a mapping (design + blank) to order items: the manual map, SKU rules at import and
 * re-mapping after a rule is learned all end here. Mapped items move to `ready`, personalized
 * designs render their artwork (flags -> `needs_artwork`) and the blank is reserved.
 */

type SkuRuleInput = z.infer<typeof SkuRuleInputSchema>;
type Placement = (typeof designFiles.$inferSelect)["placement"];

const MAPPABLE = new Set(["imported", "needs_mapping", "ready", "needs_artwork", "on_hold"]);

export type MappingTarget = {
  designId: string;
  blankVariantId: string;
  placement?: Placement;
  ruleId: string | null;
  /** How the mapping happened, for the timeline. */
  via: "manual" | "rule" | "bulk";
};

/**
 * Map items to a design + blank. Items past `needs_artwork` (already on a sheet) are skipped.
 * Returns the ids that were mapped.
 */
export async function mapItems(
  tx: Tx,
  ctx: TenantContext,
  itemIds: string[],
  target: MappingTarget,
): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const [design] = await tx
    .select({
      id: designs.id,
      code: designs.code,
      name: designs.name,
      templateId: designs.personalizationTemplateId,
    })
    .from(designs)
    .where(eq(designs.id, target.designId))
    .limit(1);
  if (!design) throw notFound("design", target.designId);
  const [blank] = await tx
    .select()
    .from(blankVariants)
    .where(eq(blankVariants.id, target.blankVariantId))
    .limit(1);
  if (!blank) throw notFound("blank_variant", target.blankVariantId);
  const files = await tx.select().from(designFiles).where(eq(designFiles.designId, design.id));
  const file =
    files.find((f) => f.placement === target.placement) ??
    files.find((f) => f.placement === "front") ??
    files[0];
  const [product] = await tx
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.designId, design.id),
        eq(products.styleCode, blank.styleCode),
        eq(products.status, "active"),
      ),
    )
    .limit(1);

  const items = await tx.select().from(orderItems).where(inArray(orderItems.id, itemIds));
  const mapped: string[] = [];
  const toReserve: string[] = [];
  for (const item of items) {
    if (!MAPPABLE.has(item.state)) continue;
    if (item.state === "on_hold" && item.heldFromState && !MAPPABLE.has(item.heldFromState))
      continue;
    const changedBlank = item.blankVariantId && item.blankVariantId !== blank.id;
    if (changedBlank) await releaseForItems(tx, ctx, [item.id]);
    await tx
      .update(orderItems)
      .set({
        designId: design.id,
        blankVariantId: blank.id,
        productId: product?.id ?? null,
        placement: file?.placement ?? target.placement ?? "front",
        printWidthIn: file ? Math.round(file.widthIn) : item.printWidthIn,
        printHeightIn: file ? Math.round(file.heightIn) : item.printHeightIn,
        flags: withFlags(item.flags, [], ["needs_mapping"]),
        ...(design.templateId
          ? {}
          : { artworkStatus: "none" as const, artworkKey: null, artworkPreviewKey: null }),
      })
      .where(eq(orderItems.id, item.id));
    await audit(tx, {
      companyId: ctx.companyId,
      actor: ctx.actor,
      action: "item.mapped",
      entityType: "order_item",
      entityId: item.id,
      summary: `${item.channelSku || "Item"} mapped to ${design.code} on ${blank.sku}${target.via === "rule" ? " (SKU rule)" : ""}`,
      data: {
        orderId: item.orderId,
        designId: design.id,
        blankVariantId: blank.id,
        ruleId: target.ruleId,
        via: target.via,
      },
    });

    let state = item.state;
    if (state === "imported" || state === "needs_mapping") {
      await transitionItem(tx, item.id, "ready", { actor: ctx.actor, reason: "mapped" });
      state = "ready";
    }
    if (design.templateId) {
      const { clean } = await renderItemArtwork(tx, ctx, item.id, {
        templateId: design.templateId,
      });
      if (!clean && state === "ready") {
        await transitionItem(tx, item.id, "needs_artwork", {
          actor: ctx.actor,
          reason: "artwork_flagged",
        });
      } else if (clean && state === "needs_artwork") {
        await transitionItem(tx, item.id, "ready", {
          actor: ctx.actor,
          reason: "artwork_rendered",
        });
      }
    } else if (state === "needs_artwork") {
      await transitionItem(tx, item.id, "ready", { actor: ctx.actor, reason: "not_personalized" });
    }
    mapped.push(item.id);
    toReserve.push(item.id);
  }
  if (toReserve.length) await reserveForItems(tx, ctx, toReserve);
  if (mapped.length) {
    await emit(tx, ctx.companyId, "item.mapped", {
      orderItemIds: mapped,
      designId: design.id,
      blankVariantId: blank.id,
      ruleId: target.ruleId,
    });
  }
  return mapped;
}

/** Unmapped units (optionally for one SKU) with their order's channel. */
async function unmappedItems(
  tx: Tx,
  filter: { channelSku?: string; channel?: Channel; excludeIds?: string[] } = {},
) {
  const rows = await tx
    .select({
      id: orderItems.id,
      sku: orderItems.channelSku,
      channel: orders.channel,
      connectionId: orders.connectionId,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        inArray(orderItems.state, ["needs_mapping", "imported"]),
        filter.channelSku ? eq(orderItems.channelSku, filter.channelSku) : undefined,
        filter.channel ? eq(orders.channel, filter.channel) : undefined,
      ),
    );
  const exclude = new Set(filter.excludeIds ?? []);
  return rows.filter((r) => !exclude.has(r.id));
}

/**
 * Run the SKU rules over every unmapped item (after a rule was learned or edited). Returns how
 * many items were mapped.
 */
export async function remapUnmapped(
  tx: Tx,
  ctx: TenantContext,
  matcher?: Matcher,
): Promise<number> {
  const m = matcher ?? (await loadMatcher(tx));
  const rows = await unmappedItems(tx);
  const groups = new Map<string, { target: MappingTarget; ids: string[] }>();
  for (const r of rows) {
    const hit = m.match(r.sku, { channel: r.channel, connectionId: r.connectionId });
    if (!hit) continue;
    const key = `${hit.designId}|${hit.blankVariantId}|${hit.ruleId}`;
    const g = groups.get(key) ?? {
      target: {
        designId: hit.designId,
        blankVariantId: hit.blankVariantId,
        ruleId: hit.ruleId,
        via: "rule" as const,
      },
      ids: [],
    };
    g.ids.push(r.id);
    groups.set(key, g);
  }
  let n = 0;
  for (const g of groups.values()) n += (await mapItems(tx, ctx, g.ids, g.target)).length;
  await recordRuleUse(tx, m);
  return n;
}

/** orderItems.map: the one-time manual map, optionally learning a rule. */
export async function mapItemManually(
  tx: Tx,
  ctx: TenantContext,
  input: {
    id: string;
    designId: string;
    blankVariantId: string;
    placement?: Placement;
    applyToSameSku: boolean;
    saveRule?: SkuRuleInput;
  },
) {
  const item = await getItemRow(tx, input.id);
  if (!MAPPABLE.has(item.state))
    throw conflict(
      `The item is already ${item.state.replace(/_/g, " ")}; it can no longer be re-mapped`,
    );
  const [order] = await tx
    .select({ channel: orders.channel })
    .from(orders)
    .where(eq(orders.id, item.orderId))
    .limit(1);
  const siblings = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(
      and(eq(orderItems.orderId, item.orderId), eq(orderItems.channelLineId, item.channelLineId)),
    );
  const ids = new Set([item.id, ...siblings.map((s) => s.id)]);
  if (input.applyToSameSku && item.channelSku) {
    for (const r of await unmappedItems(tx, {
      channelSku: item.channelSku,
      channel: order?.channel,
    }))
      ids.add(r.id);
  }

  let ruleId: string | null = null;
  if (input.saveRule) {
    const rule = await createRule(tx, ctx, input.saveRule, "learned");
    ruleId = rule.id;
  }
  const mapped = await mapItems(tx, ctx, [...ids], {
    designId: input.designId,
    blankVariantId: input.blankVariantId,
    placement: input.placement,
    ruleId,
    via: "manual",
  });
  // A learned rule may cover other SKUs too (templates, regexes): map everything it now matches.
  const more = input.saveRule ? await remapUnmapped(tx, ctx) : 0;
  return { item: await getItem(tx, ctx, item.id), itemsMapped: mapped.length + more, ruleId };
}

/** skuRules.bulkApply: accept many suggestions at once. */
export async function bulkApply(
  tx: Tx,
  ctx: TenantContext,
  input: {
    mappings: {
      channelSku: string;
      channel?: Channel;
      designId: string;
      blankVariantId: string;
      saveRule?: SkuRuleInput;
    }[];
  },
) {
  let itemsMapped = 0;
  let rulesCreated = 0;
  const failed: { channelSku: string; message: string }[] = [];
  for (const m of input.mappings) {
    try {
      let ruleId: string | null = null;
      if (m.saveRule) {
        ruleId = (await createRule(tx, ctx, m.saveRule, "learned")).id;
        rulesCreated++;
      }
      const ids = (await unmappedItems(tx, { channelSku: m.channelSku, channel: m.channel })).map(
        (r) => r.id,
      );
      itemsMapped += (
        await mapItems(tx, ctx, ids, {
          designId: m.designId,
          blankVariantId: m.blankVariantId,
          ruleId,
          via: "bulk",
        })
      ).length;
    } catch (err) {
      failed.push({
        channelSku: m.channelSku,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (rulesCreated) itemsMapped += await remapUnmapped(tx, ctx);
  return { itemsMapped, rulesCreated, failed };
}
