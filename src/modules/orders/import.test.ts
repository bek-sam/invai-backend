import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedOrder } from "@invai/contracts";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../../api/context";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, designs, orderItems, orders, outboxEvents } from "../../db/schema";
import { parseOrdersCsv } from "../../integrations/channels/csv";
import { imaging } from "../../integrations/imaging/client";
import { runJobInline } from "../../lib/queues";
import { ensureBucket, objectKey, putObject } from "../../lib/s3";
import {
  createCompany,
  createConnection,
  createLocation,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { bulkImportBlanks, createDesign } from "../catalog/service";
import { getConnectionRow } from "../channels/service";
import { createRule, testRule } from "../channels/sku";
import { importCsv } from "../channels/sync";
import { renderArtworkJob } from "../personalization/jobs";
import { createTemplate } from "../personalization/service";
import { importNormalizedOrders } from "./import";
import { purgeBuyerPii } from "./jobs";
import { mapItemManually } from "./mapping";
import { cancelOrder, holdOrder, listOrders, releaseOrder, timeline } from "./service";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "../../integrations/channels/csv/fixtures", name), "utf8");

let companyId: string;
let ctx: TenantContext;
let etsyConnId: string;
let imagingUp = false;
const designIds: Record<string, string> = {};
const blankIds: Record<string, string> = {};

async function seedCatalog() {
  await withTenant(companyId, async (tx) => {
    await createRule(tx, ctx, {
      name: "Standard",
      patternType: "template",
      pattern: "{design}-{style}-{color}-{size}",
      channel: null,
      connectionId: null,
      target: { kind: "resolve", defaults: {} },
      priority: 10,
      active: true,
    });
    const colors = [
      ["Black", "BLK"],
      ["Sand", "SND"],
      ["White", "WHT"],
    ];
    await bulkImportBlanks(tx, ctx, {
      rows: colors.flatMap(([color, colorCode]) =>
        ["S", "M", "L", "XL"].map((size) => ({
          brand: "Gildan",
          style: "64000",
          styleCode: "G64000",
          styleName: null,
          color: color as string,
          colorCode: colorCode as string,
          colorHex: null,
          size,
          sizeCode: size,
          supplier: "ssactivewear" as const,
          supplierSku: `B${colorCode}${size}`,
          cost: 289,
          weightOz: 5.3,
        })),
      ),
    });
    const template = await createTemplate(tx, ctx, {
      name: "Bride Tribe",
      widthIn: 11,
      heightIn: 12,
      backgroundKey: null,
      dpi: 300,
      slots: [
        {
          name: "name",
          kind: "text",
          xIn: 0.5,
          yIn: 8.2,
          wIn: 10,
          hIn: 1.6,
          fontFamily: "Inter Bold",
          fontSizePt: 48,
          minFontSizePt: null,
          maxLines: null,
          strokeWidthPt: 0,
          strokeColor: null,
          fit: "fit",
          color: "#1a1a1a",
          align: "center",
          maxChars: 16,
          uppercase: true,
          sourceQuestion: "name",
          required: true,
          placeholder: null,
        },
      ],
    });
    for (const [code, name, templateId] of [
      ["DB001", "Saguaro Sunset", null],
      ["DB019", "Retro Rainbow Wave", null],
      ["DB025", "Bride Tribe Cactus", template.id],
    ] as const) {
      const d = await createDesign(tx, ctx, {
        code,
        name,
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: `${companyId}/design/${code}.png`,
            widthIn: 11,
            heightIn: 12,
          },
        ],
        personalizationTemplateId: templateId,
      });
      designIds[code] = d.id;
    }
  });
  const { blankVariants } = await import("../../db/schema");
  const rows = await withTenant(companyId, (tx) => tx.select().from(blankVariants));
  for (const b of rows) blankIds[b.sku] = b.id;
}

beforeAll(async () => {
  const company = await createCompany();
  companyId = company.id;
  const owner = await createUser(companyId, "owner");
  ctx = tenantContext(companyId, owner.id, "owner");
  await createLocation(companyId);
  etsyConnId = (await createConnection(companyId, "etsy")).id;
  imagingUp = await imaging.isUp();
  await ensureBucket();
  await seedCatalog();
});

const itemsOf = (orderId: string) =>
  withTenant(companyId, (tx) =>
    tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.lineNo, orderItems.unitNo),
  );

describe("CSV import pipeline", () => {
  let etsyOrders: { id: string; channelOrderId: string }[] = [];

  it("imports the Etsy export: one item per unit, mapped, personalized, unmapped", async () => {
    const key = objectKey(companyId, "csv", "csv");
    await putObject(key, fixture("etsy-sold-order-items.csv"), "text/csv");
    const report = await importCsv(ctx, { id: etsyConnId, fileKey: key, format: "etsy" });
    expect(report).toMatchObject({
      status: "completed",
      rowsTotal: 6,
      ordersImported: 4,
      rowsFailed: 1,
      itemsNeedingMapping: 1,
    });
    expect(report.errors).toEqual([{ row: 7, message: "Missing quantity" }]);

    etsyOrders = await withTenant(companyId, (tx) =>
      tx.select({ id: orders.id, channelOrderId: orders.channelOrderId }).from(orders),
    );
    const byChannelId = new Map(etsyOrders.map((o) => [o.channelOrderId, o.id]));

    const multi = await itemsOf(byChannelId.get("3310000001") as string);
    expect(multi.map((i) => [i.lineNo, i.unitNo, i.unitsInLine, i.state])).toEqual([
      [1, 1, 1, "ready"],
      [2, 1, 2, "ready"],
      [2, 2, 2, "ready"],
    ]);
    expect(multi[1]?.designId).toBe(designIds.DB019);
    expect(multi[1]?.blankVariantId).toBe(blankIds["G64000-SND-L"]);

    const unmapped = await itemsOf(byChannelId.get("3310000004") as string);
    expect(unmapped[0]?.state).toBe("needs_mapping");
    expect(unmapped[0]?.flags.map((f) => f.code)).toEqual(["needs_mapping"]);

    // The import only queues the personalization renders (B-61); the render job runs after.
    const queued = [
      ...(await itemsOf(byChannelId.get("3310000002") as string)),
      ...(await itemsOf(byChannelId.get("3310000003") as string)),
    ];
    expect(queued.map((i) => i.artworkStatus)).toEqual(["pending", "pending"]);
    const requested = await withSystem((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.name, "artwork.render_requested")),
    );
    const orderItemIds = requested
      .filter((e) => e.companyId === companyId)
      .flatMap((e) => e.payload.orderItemIds as string[]);
    expect(orderItemIds.sort()).toEqual(queued.map((i) => i.id).sort());
    await runJobInline(renderArtworkJob, { companyId, orderItemIds });

    const ashley = (await itemsOf(byChannelId.get("3310000002") as string))[0];
    const jessica = (await itemsOf(byChannelId.get("3310000003") as string))[0];
    if (imagingUp) {
      expect(ashley).toMatchObject({ state: "ready", artworkStatus: "rendered" });
      expect(ashley?.artworkKey).toMatch(/\/artwork\//);
      expect(jessica).toMatchObject({ state: "needs_artwork", artworkStatus: "flagged" });
      expect(jessica?.flags.map((f) => f.code)).toContain("artwork_overflow");
    } else {
      expect(ashley?.state).toBe("needs_artwork");
    }

    // PII is stored encrypted: the raw column is ciphertext.
    const raw = await withSystem((tx) =>
      tx.execute<{ name: string }>(
        `select name from buyer_pii where company_id = '${companyId}' limit 1` as never,
      ),
    );
    expect(raw.rows[0]?.name).toMatch(/^[a-z0-9]+:/);
    expect(raw.rows[0]?.name).not.toMatch(/Gonzalez|Brooks|Montgomery|Nguyen/);
  });

  it("is idempotent: the same file again skips every order", async () => {
    const key = objectKey(companyId, "csv", "csv");
    await putObject(key, fixture("etsy-sold-order-items.csv"), "text/csv");
    const report = await importCsv(ctx, { id: etsyConnId, fileKey: key, format: "etsy" });
    expect(report).toMatchObject({ ordersImported: 0, ordersUpdated: 0, ordersSkipped: 4 });
    const count = await withTenant(companyId, (tx) =>
      tx.select({ id: orderItems.id }).from(orderItems),
    );
    expect(count).toHaveLength(6);
  });

  it("updates a changed address on re-import", async () => {
    const conn = await withTenant(companyId, (tx) => getConnectionRow(tx, etsyConnId));
    const parsed = parseOrdersCsv("etsy", fixture("etsy-sold-order-items.csv"));
    const first = parsed.orders[0] as NormalizedOrder;
    const moved = {
      ...first,
      shipTo: { ...(first.shipTo as NonNullable<NormalizedOrder["shipTo"]>), street1: "99 New St" },
    };
    const res = await withTenant(companyId, (tx) =>
      importNormalizedOrders(tx, ctx, conn, [moved], { source: "api" }),
    );
    expect(res).toMatchObject({ updated: 1, imported: 0 });
    const [pii] = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(buyerPii)
        .innerJoin(orders, eq(orders.id, buyerPii.orderId))
        .where(eq(orders.channelOrderId, first.channelOrderId)),
    );
    expect(pii?.buyer_pii.street1).toBe("99 New St");
  });

  it("maps an unknown SKU once, learns the rule and maps its siblings", async () => {
    const conn = await withTenant(companyId, (tx) => getConnectionRow(tx, etsyConnId));
    const sibling: NormalizedOrder = {
      ...(parseOrdersCsv("etsy", fixture("etsy-sold-order-items.csv"))
        .orders[3] as NormalizedOrder),
      channelOrderId: "3310000099",
      orderNo: "3310000099",
    };
    await withTenant(companyId, (tx) =>
      importNormalizedOrders(tx, ctx, conn, [sibling], { source: "api" }),
    );
    const unmapped = await withTenant(companyId, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.state, "needs_mapping")),
    );
    expect(unmapped).toHaveLength(2);
    const target = {
      designId: designIds.DB001 as string,
      blankVariantId: blankIds["G64000-BLK-XL"] as string,
    };
    const out = await withTenant(companyId, (tx) =>
      mapItemManually(tx, ctx, {
        id: unmapped[0]?.id as string,
        ...target,
        applyToSameSku: false,
        saveRule: {
          name: null,
          patternType: "exact",
          pattern: "ETSY-OLD-CACTUS-XL",
          channel: "etsy",
          connectionId: null,
          target: { kind: "direct", ...target },
          priority: 100,
          active: true,
        },
      }),
    );
    expect(out.itemsMapped).toBe(2);
    expect(out.ruleId).toBeTruthy();
    expect(out.item.state).toBe("ready");
    const left = await withTenant(companyId, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.state, "needs_mapping")),
    );
    expect(left).toHaveLength(0);
    const events = await withSystem((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.name, "sku_rule.learned")),
    );
    expect(events.some((e) => e.companyId === companyId)).toBe(true);
  });

  it("holds and releases to the held-from state, then cancels with a timeline", async () => {
    const orderId = etsyOrders.find((o) => o.channelOrderId === "3310000001")?.id as string;
    const held = await withTenant(companyId, (tx) =>
      holdOrder(tx, ctx, { id: orderId, reason: "address_check", note: "confirm apt" }),
    );
    expect(held.status).toBe("on_hold");
    expect(held.items.every((i) => i.state === "on_hold" && i.heldFromState === "ready")).toBe(
      true,
    );
    const released = await withTenant(companyId, (tx) => releaseOrder(tx, ctx, orderId));
    expect(released.items.every((i) => i.state === "ready")).toBe(true);
    expect(released.hold).toBeNull();

    const partial = await withTenant(companyId, (tx) =>
      cancelOrder(tx, ctx, {
        id: orderId,
        reason: "buyer_request",
        note: null,
        orderItemIds: [released.items[2]?.id as string],
      }),
    );
    expect(partial.items.map((i) => i.state)).toEqual(["ready", "ready", "cancelled"]);
    expect(partial.cancel).toBeNull();
    const all = await withTenant(companyId, (tx) =>
      cancelOrder(tx, ctx, { id: orderId, reason: "buyer_request", note: "changed mind" }),
    );
    expect(all.status).toBe("cancelled");
    expect(all.cancel?.reason).toBe("buyer_request");

    const tl = await withTenant(companyId, (tx) => timeline(tx, ctx, { id: orderId, limit: 100 }));
    const kinds = new Set(tl.items.map((e) => e.kind));
    for (const k of ["imported", "mapped", "held", "released", "cancelled", "state_changed"])
      expect(kinds).toContain(k);
    const page1 = await withTenant(companyId, (tx) => timeline(tx, ctx, { id: orderId, limit: 3 }));
    const page2 = await withTenant(companyId, (tx) =>
      timeline(tx, ctx, { id: orderId, limit: 3, cursor: page1.nextCursor as string }),
    );
    expect(page2.items[0]?.id).not.toBe(page1.items[2]?.id);
  });

  it("lists with the itemState filter and keyset paging", async () => {
    const needsArtwork = await withTenant(companyId, (tx) =>
      listOrders(tx, ctx, { limit: 50, sort: "shipBy", dir: "asc", itemState: ["needs_artwork"] }),
    );
    expect(needsArtwork.items.length).toBe(imagingUp ? 1 : 2);
    const p1 = await withTenant(companyId, (tx) =>
      listOrders(tx, ctx, { limit: 2, sort: "placedAt", dir: "desc" }),
    );
    const p2 = await withTenant(companyId, (tx) =>
      listOrders(tx, ctx, {
        limit: 2,
        sort: "placedAt",
        dir: "desc",
        cursor: p1.nextCursor as string,
      }),
    );
    const ids = [...p1.items, ...p2.items].map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(p1.items[0]?.buyerName).toBeTruthy();
  });

  it("cancels orders the channel reports as cancelled", async () => {
    const tt = await createConnection(companyId, "tiktok");
    const conn = await withTenant(companyId, (tx) => getConnectionRow(tx, tt.id));
    const parsed = parseOrdersCsv("tiktok", fixture("tiktok-orders.csv"));
    const first = await withTenant(companyId, (tx) =>
      importNormalizedOrders(tx, ctx, conn, parsed.orders, { source: "csv" }),
    );
    expect(first.imported).toBe(2);
    const res = await withTenant(companyId, (tx) =>
      importNormalizedOrders(tx, ctx, conn, [], {
        source: "csv",
        cancelledChannelOrderIds: [parsed.orders[0]?.channelOrderId as string, "not-imported"],
      }),
    );
    expect(res.cancelled).toBe(1);
  });
});

describe("SKU templates", () => {
  it("parses {style}-{color}-{size}-{design} and resolves by code", async () => {
    const res = await withTenant(companyId, (tx) =>
      testRule(tx, ctx, {
        patternType: "template",
        pattern: "{style}-{color}-{size}-{design}",
        target: { kind: "resolve", defaults: {} },
        sample: "G64000-SND-XL-DB019",
      }),
    );
    expect(res).toMatchObject({
      matched: true,
      fields: { style: "G64000", color: "SND", size: "XL", design: "DB019" },
      designId: designIds.DB019,
      blankVariantId: blankIds["G64000-SND-XL"],
      error: null,
    });
    const miss = await withTenant(companyId, (tx) =>
      testRule(tx, ctx, {
        patternType: "template",
        pattern: "{design}-{color}-{size}",
        target: { kind: "resolve", defaults: { style: "G64000" } },
        sample: "DB999-BLK-M",
      }),
    );
    expect(miss).toMatchObject({ matched: true, designId: null, error: 'Unknown design "DB999"' });
  });
});

describe("buyer PII purge", () => {
  it("deletes PII 30 days after delivery and keeps the order", async () => {
    const [o] = await withTenant(companyId, (tx) => tx.select().from(orders).limit(1));
    const old = new Date(Date.now() - 31 * 86400_000);
    await withSystem((tx) =>
      tx
        .update(orders)
        .set({ deliveredAt: old })
        .where(eq(orders.id, o?.id as string)),
    );
    const res = await purgeBuyerPii();
    expect(res.purged).toBeGreaterThanOrEqual(1);
    const left = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(buyerPii)
        .where(eq(buyerPii.orderId, o?.id as string)),
    );
    expect(left).toHaveLength(0);
    const still = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(orders)
        .where(eq(orders.id, o?.id as string)),
    );
    expect(still).toHaveLength(1);
    void designs;
  });
});
