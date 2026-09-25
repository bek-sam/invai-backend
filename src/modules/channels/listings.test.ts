import type { NormalizedOrder } from "@invai/contracts";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../../api/context";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  channelConnections,
  listings,
  listingVariants,
  outboxEvents,
} from "../../db/schema";
import { runJobInline, subscribersOf } from "../../lib/queues";
import { createCompany, createLocation, createUser, tenantContext } from "../../test/fixtures";
import { bulkImportBlanks, createDesign } from "../catalog/service";
import { recordListingsJob } from "../inventory/jobs";
import { importNormalizedOrders } from "../orders/import";
import { mapItemManually } from "../orders/mapping";
import { getConnectionRow } from "./service";
import { createRule, recordListingsForCompany, recordListingsForItems } from "./sku";

let companyId: string;
let ctx: TenantContext;
let connId: string;
const designIds: Record<string, string> = {};
const blankIds: Record<string, string> = {};
let seq = 0;

async function seedCatalog(company: string, c: TenantContext) {
  await withTenant(company, async (tx) => {
    await createRule(tx, c, {
      name: "Standard",
      patternType: "template",
      pattern: "{design}-{style}-{color}-{size}",
      channel: null,
      connectionId: null,
      target: { kind: "resolve", defaults: {} },
      priority: 10,
      active: true,
    });
    await bulkImportBlanks(tx, c, {
      rows: ["S", "M", "L"].map((size) => ({
        brand: "Gildan",
        style: "64000",
        styleCode: "G64000",
        styleName: null,
        color: "Black",
        colorCode: "BLK",
        colorHex: null,
        size,
        sizeCode: size,
        supplier: "ssactivewear" as const,
        supplierSku: `BBLK${size}`,
        cost: 289,
        weightOz: 5.3,
      })),
    });
    for (const [code, name] of [
      ["DB001", "Saguaro Sunset"],
      ["DB019", "Retro Rainbow Wave"],
    ] as const) {
      const d = await createDesign(tx, c, {
        code,
        name,
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: `${company}/design/${code}.png`,
            widthIn: 11,
            heightIn: 12,
          },
        ],
        personalizationTemplateId: null,
      });
      designIds[code] = d.id;
    }
  });
  const rows = await withTenant(company, (tx) => tx.select().from(blankVariants));
  for (const b of rows) blankIds[b.sku] = b.id;
}

async function shopifyConnection(company: string) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId: company,
        channel: "shopify",
        name: "Test store",
        status: "connected",
        mode: "api",
        provider: "mock",
        externalShopId: `t33-${company.slice(0, 8)}.myshopify.com`,
      })
      .returning(),
  );
  if (!row) throw new Error("connection insert failed");
  return row.id;
}

function order(lines: { sku: string; listing: string; qty?: number }[]): NormalizedOrder {
  seq++;
  return {
    channel: "shopify",
    channelOrderId: `t33-${seq}-${Date.now()}`,
    orderNo: `#T33-${seq}`,
    placedAt: new Date().toISOString(),
    shipBy: null,
    isRush: false,
    buyerName: "Test Buyer",
    buyerEmail: null,
    shipTo: null,
    shippingMethod: "Standard",
    totals: { subtotal: 2800, shipping: 0, tax: 0, discount: 0, total: 2800 },
    buyerNote: null,
    items: lines.map((l, i) => ({
      channelLineId: `${seq}-${i}`,
      channelSku: l.sku,
      channelListingId: l.listing,
      title: "Saguaro Sunset Tee",
      variantTitle: l.sku.endsWith("-S") ? "Black / S" : "Black / M",
      quantity: l.qty ?? 1,
      unitPrice: 2800,
      personalization: [],
    })),
  };
}

async function importOne(n: NormalizedOrder) {
  const conn = await withTenant(companyId, (tx) => getConnectionRow(tx, connId));
  return withTenant(companyId, (tx) =>
    importNormalizedOrders(tx, ctx, conn, [n], { source: "webhook" }),
  );
}

/** Run every recordListings subscription for this company's undispatched events, like the relay. */
async function relayListingEvents() {
  const events = await withSystem((tx) =>
    tx.select().from(outboxEvents).where(eq(outboxEvents.companyId, companyId)),
  );
  let ran = 0;
  for (const e of events) {
    for (const sub of subscribersOf(e.name)) {
      if (sub.job !== recordListingsJob) continue;
      const input = sub.map({ id: e.id, companyId: e.companyId, name: e.name, payload: e.payload });
      if (input) {
        await runJobInline(recordListingsJob, input as never);
        ran++;
      }
    }
  }
  return ran;
}

const variantsOf = (company: string) =>
  withTenant(company, (tx) =>
    tx
      .select({
        sku: listingVariants.channelSku,
        channelVariantId: listingVariants.channelVariantId,
        designId: listingVariants.designId,
        blankVariantId: listingVariants.blankVariantId,
        priceCents: listingVariants.priceCents,
        channelListingId: listings.channelListingId,
        connectionId: listings.connectionId,
      })
      .from(listingVariants)
      .innerJoin(listings, eq(listings.id, listingVariants.listingId)),
  );

beforeAll(async () => {
  companyId = (await createCompany()).id;
  const owner = await createUser(companyId, "owner");
  ctx = tenantContext(companyId, owner.id, "owner");
  await createLocation(companyId);
  await seedCatalog(companyId, ctx);
  connId = await shopifyConnection(companyId);
});

describe("listings recorded from orders", () => {
  it("an imported order records its listing and variants through the order.imported event", async () => {
    await importOne(
      order([
        { sku: "DB001-G64000-BLK-S", listing: "8100000001", qty: 2 },
        { sku: "DB001-G64000-BLK-M", listing: "8100000001" },
        { sku: "MYSTERY-SKU-1", listing: "8100000001" },
      ]),
    );
    expect(await relayListingEvents()).toBeGreaterThan(0);

    const rows = await variantsOf(companyId);
    const bySku = new Map(rows.map((r) => [r.sku, r]));
    expect(rows).toHaveLength(3);
    expect(bySku.get("DB001-G64000-BLK-S")).toMatchObject({
      channelVariantId: "DB001-G64000-BLK-S",
      channelListingId: "8100000001",
      connectionId: connId,
      designId: designIds.DB001,
      blankVariantId: blankIds["G64000-BLK-S"],
      priceCents: 2800,
    });
    expect(bySku.get("DB001-G64000-BLK-M")?.blankVariantId).toBe(blankIds["G64000-BLK-M"]);
    // Unmapped SKUs are recorded too, without a blank (nothing to push until they map).
    expect(bySku.get("MYSTERY-SKU-1")).toMatchObject({ designId: null, blankVariantId: null });

    const [listing] = await withTenant(companyId, (tx) =>
      tx.select().from(listings).where(eq(listings.channelListingId, "8100000001")),
    );
    expect(listing).toMatchObject({
      channel: "shopify",
      title: "Saguaro Sunset Tee",
      designId: designIds.DB001,
    });
  });

  it("is idempotent: replaying the events and a second order add no rows", async () => {
    await relayListingEvents();
    await importOne(order([{ sku: "DB001-G64000-BLK-S", listing: "8100000001" }]));
    await relayListingEvents();
    const rows = await variantsOf(companyId);
    expect(rows).toHaveLength(3);
    const count = await withTenant(companyId, (tx) => tx.select().from(listings));
    expect(count).toHaveLength(1);
  });

  it("queues an availability push only for variants that are new or re-mapped", async () => {
    const itemIds = await withTenant(companyId, async (tx) => {
      const { orderItems } = await import("../../db/schema");
      return (await tx.select({ id: orderItems.id }).from(orderItems)).map((r) => r.id);
    });
    const again = await withTenant(companyId, (tx) =>
      recordListingsForItems(tx, companyId, itemIds),
    );
    expect(again.blankVariantIds).toEqual([]);
  });

  it("a manual map records the blank on the listing variant (item.mapped)", async () => {
    const res = await importOne(order([{ sku: "MYSTERY-SKU-1", listing: "8100000001" }]));
    const orderId = res.orderIds[0] as string;
    const { orderItems } = await import("../../db/schema");
    const [item] = await withTenant(companyId, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    );
    await withTenant(companyId, (tx) =>
      mapItemManually(tx, ctx, {
        id: item?.id as string,
        designId: designIds.DB019 as string,
        blankVariantId: blankIds["G64000-BLK-L"] as string,
        applyToSameSku: false,
      }),
    );
    await relayListingEvents();
    const v = (await variantsOf(companyId)).find((r) => r.sku === "MYSTERY-SKU-1");
    expect(v).toMatchObject({
      designId: designIds.DB019,
      blankVariantId: blankIds["G64000-BLK-L"],
    });
  });

  it("saving a SKU rule re-maps the listing variants it matches and queues their push", async () => {
    await importOne(order([{ sku: "ODD-SKU-2", listing: "8100000002" }]));
    await relayListingEvents();
    expect((await variantsOf(companyId)).find((r) => r.sku === "ODD-SKU-2")?.blankVariantId).toBe(
      null,
    );
    await withTenant(companyId, (tx) =>
      createRule(tx, ctx, {
        name: null,
        patternType: "exact",
        pattern: "odd-sku-2",
        channel: null,
        connectionId: null,
        target: {
          kind: "direct",
          designId: designIds.DB019 as string,
          blankVariantId: blankIds["G64000-BLK-M"] as string,
        },
        priority: 0,
        active: true,
      }),
    );
    expect((await variantsOf(companyId)).find((r) => r.sku === "ODD-SKU-2")).toMatchObject({
      designId: designIds.DB019,
      blankVariantId: blankIds["G64000-BLK-M"],
    });
    const events = await withSystem((tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.companyId, companyId),
            eq(outboxEvents.name, "stock.availability_changed"),
          ),
        ),
    );
    expect(
      events.some((e) =>
        (e.payload as { blankVariantIds: string[] }).blankVariantIds.includes(
          blankIds["G64000-BLK-M"] as string,
        ),
      ),
    ).toBe(true);
  });

  it("backfills a company's listings from its orders (the seed path)", async () => {
    await withTenant(companyId, (tx) => tx.delete(listings));
    expect(await variantsOf(companyId)).toHaveLength(0);
    const res = await withTenant(companyId, (tx) => recordListingsForCompany(tx, companyId));
    expect(res.listings).toBe(2);
    const rows = await variantsOf(companyId);
    expect(rows.map((r) => r.sku).sort()).toEqual([
      "DB001-G64000-BLK-M",
      "DB001-G64000-BLK-S",
      "MYSTERY-SKU-1",
      "ODD-SKU-2",
    ]);
    // The latest mapped unit wins: MYSTERY-SKU-1 was mapped by hand after its first import.
    expect(rows.find((r) => r.sku === "MYSTERY-SKU-1")?.blankVariantId).toBe(
      blankIds["G64000-BLK-L"],
    );
  });

  it("keeps listings inside the tenant", async () => {
    const other = (await createCompany()).id;
    const itemIds = await withTenant(companyId, async (tx) => {
      const { orderItems } = await import("../../db/schema");
      return (await tx.select({ id: orderItems.id }).from(orderItems)).map((r) => r.id);
    });
    // Another company naming A's items records nothing, and sees none of A's listings.
    const res = await withTenant(other, (tx) => recordListingsForItems(tx, other, itemIds));
    expect(res).toEqual({ listings: 0, variants: 0, blankVariantIds: [] });
    expect(await variantsOf(other)).toHaveLength(0);
    expect(await withTenant(other, (tx) => tx.select().from(listings))).toHaveLength(0);
  });
});
