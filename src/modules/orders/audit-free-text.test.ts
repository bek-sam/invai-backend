import type { NormalizedOrder } from "@invai/contracts";
import { ROLE_PERMISSIONS } from "@invai/contracts";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../../api/context";
import { withTenant } from "../../db/client";
import {
  auditLog,
  blankVariants,
  type channelConnections,
  orderItems,
  orderItemTransitions,
  orderNotes,
} from "../../db/schema";
import { env } from "../../env";
import { audit } from "../../lib/audit";
import { hmacHex } from "../../lib/crypto";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { bulkImportBlanks, createDesign } from "../catalog/service";
import { getConnectionRow } from "../channels/service";
import { createRule } from "../channels/sku";
import { importNormalizedOrders } from "./import";
import { addNote, cancelOrder, holdOrder, setItemFlag, timeline } from "./service";

/*
 * T-52-4 (B-453, decision 0027): staff and channel free text never lands in an append-only row.
 */

let companyId: string;
let ctx: TenantContext;
let conn: typeof channelConnections.$inferSelect;
const designIds: Record<string, string> = {};

beforeAll(async () => {
  companyId = (await createCompany()).id;
  const owner = await createUser(companyId, "owner");
  ctx = tenantContext(companyId, owner.id, "owner");
  await createLocation(companyId);
  const shop = await createConnection(companyId, "shopify");
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
    await bulkImportBlanks(tx, ctx, {
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
    for (const code of ["DB001", "DB019"]) {
      const d = await createDesign(tx, ctx, {
        code,
        name: code,
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: `${companyId}/design/${code}.png`,
            widthIn: 11,
            heightIn: 12,
          },
        ],
        personalizationTemplateId: null,
      });
      designIds[code] = d.id;
    }
    conn = await getConnectionRow(tx, shop.id);
  });
  expect(await withTenant(companyId, (tx) => tx.select().from(blankVariants))).toHaveLength(3);
});

let seq = 0;
function order(
  lines: { id: string; sku: string; qty: number; name?: string }[],
  extra: Partial<NormalizedOrder> = {},
): NormalizedOrder {
  return {
    channel: "shopify",
    channelOrderId: `T74-${seq}`,
    orderNo: `#T74-${seq}`,
    placedAt: "2026-11-24T17:00:00.000Z",
    shipBy: null,
    isRush: false,
    buyerName: "Ana Buyer",
    buyerEmail: null,
    shipTo: null,
    shippingMethod: "Standard",
    totals: { subtotal: 2500, shipping: 500, tax: 0, discount: 0, total: 3000 },
    buyerNote: null,
    items: lines.map((l) => ({
      channelLineId: l.id,
      channelSku: l.sku,
      channelListingId: null,
      title: "Tee",
      variantTitle: null,
      quantity: l.qty,
      unitPrice: 2500,
      personalization: l.name ? [{ question: "name", answer: l.name, fileUrl: null }] : [],
    })),
    sourceUpdatedAt: null,
    ...extra,
  };
}

const run = (
  list: NormalizedOrder[],
  source: "api" | "webhook" | "csv" = "webhook",
  c = conn,
  extra: Parameters<typeof importNormalizedOrders>[4] = { source },
) => withTenant(companyId, (tx) => importNormalizedOrders(tx, ctx, c, list, { ...extra, source }));

const unitsOf = (orderId: string) =>
  withTenant(companyId, (tx) =>
    tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.lineNo, orderItems.unitNo),
  );
const setState = (ids: string[], state: "pressed" | "packed") =>
  withTenant(companyId, async (tx) => {
    for (const id of ids) await tx.update(orderItems).set({ state }).where(eq(orderItems.id, id));
  });

const BUYER_TEXT = "Zed Quimby 555-0142";
const auditFor = (entityId: string, action: string) =>
  withTenant(companyId, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action))),
  );
const fingerprintOf = (r: { data: unknown } | undefined) =>
  ((r?.data ?? {}) as { fingerprint?: string }).fingerprint;
const hashOf = (fp: string) => hmacHex(env.BETTER_AUTH_SECRET, `edit-after-press:${fp}`);

describe("edit-after-press fingerprint (A6)", () => {
  const SKU = "DB001-G64000-BLK-M";
  it("stores a keyed hash, never the buyer's answers, and still dedupes", async () => {
    seq++;
    const id = (await run([order([{ id: "a", sku: SKU, qty: 1, name: "Zed" }])]))
      .orderIds[0] as string;
    const [u] = await unitsOf(id);
    await setState([u?.id as string], "pressed");
    await run([order([{ id: "a", sku: SKU, qty: 1, name: BUYER_TEXT }])]);
    const rows = await auditFor(u?.id as string, "item.flag");
    expect(rows).toHaveLength(1);
    const fp = fingerprintOf(rows[0]);
    const plain = `${SKU}|${JSON.stringify([["name", BUYER_TEXT, null]])}`;
    expect(fp).toBe(hashOf(plain));
    expect(JSON.stringify(rows[0])).not.toContain("Quimby");
    // cleared flag + same channel values: not raised again
    await withTenant(companyId, (tx) =>
      tx
        .update(orderItems)
        .set({ flags: [] })
        .where(eq(orderItems.id, u?.id as string)),
    );
    await run([order([{ id: "a", sku: SKU, qty: 1, name: BUYER_TEXT }])]);
    expect(await auditFor(u?.id as string, "item.flag")).toHaveLength(1);
    expect((await unitsOf(id))[0]?.flags).toEqual([]);
  });

  it("a flag written with the legacy plain fingerprint is not raised again", async () => {
    seq++;
    const id = (await run([order([{ id: "a", sku: SKU, qty: 1, name: "Zed" }])]))
      .orderIds[0] as string;
    const [u] = await unitsOf(id);
    await setState([u?.id as string], "pressed");
    const plain = `${SKU}|${JSON.stringify([["name", "Zoe", null]])}`;
    await withTenant(companyId, (tx) =>
      audit(tx, {
        companyId,
        actor: ctx.actor,
        action: "item.flag",
        entityType: "order_item",
        entityId: u?.id as string,
        summary: "Flagged channel edit after press",
        data: { orderId: id, code: "channel_edit_after_press", active: true, fingerprint: plain },
      }),
    );
    await run([order([{ id: "a", sku: SKU, qty: 1, name: "Zoe" }])]);
    expect(await auditFor(u?.id as string, "item.flag")).toHaveLength(1);
    expect((await unitsOf(id))[0]?.flags).toEqual([]);
  });

  it("a channel cancel after press hashes its fingerprint too", async () => {
    seq++;
    const id = (await run([order([{ id: "a", sku: SKU, qty: 1 }])])).orderIds[0] as string;
    const [u] = await unitsOf(id);
    await setState([u?.id as string], "pressed");
    await run([order([{ id: "b", sku: "DB019-G64000-BLK-L", qty: 1 }])]);
    const rows = await auditFor(u?.id as string, "item.flag");
    expect(rows).toHaveLength(1);
    expect(fingerprintOf(rows[0])).toBe(hashOf("cancel|the line removed"));
  });
});

describe("transition rows carry no staff note (A5)", () => {
  it("hold and cancel notes stay out of order_item_transitions and item.state_changed audit rows", async () => {
    const { order: o, items } = await createOrder(companyId, conn.id, { units: 1, state: "ready" });
    await withTenant(companyId, (tx) =>
      holdOrder(tx, ctx, { id: o.id, reason: "address_check", note: BUYER_TEXT }),
    );
    await withTenant(companyId, (tx) =>
      cancelOrder(tx, ctx, { id: o.id, reason: "buyer_request", note: BUYER_TEXT }),
    );
    const trans = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(orderItemTransitions)
        .where(eq(orderItemTransitions.orderItemId, items[0]?.id as string)),
    );
    expect(trans.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(trans)).not.toContain("Quimby");
    const aud = await auditFor(items[0]?.id as string, "item.state_changed");
    expect(aud.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(aud)).not.toContain("Quimby");
  });
});

describe("staff free text lives in order_notes, not audit_log (A4)", () => {
  const TEXT = "Marta Quimby 555-0199";
  const auditOf = (cid: string) =>
    withTenant(cid, (tx) => tx.select().from(auditLog).where(eq(auditLog.companyId, cid)));

  it("note, hold, flag and cancel notes appear in the timeline and in no append-only row", async () => {
    const co = (await createCompany()).id;
    const conn2 = await createConnection(co, "shopify");
    await createLocation(co);
    const office = await createUser(co, "office");
    const c = tenantContext(co, office.id, "office");
    const a = await createOrder(co, conn2.id, { units: 1, state: "ready" });
    const b = await createOrder(co, conn2.id, { units: 1, state: "ready" });
    const itemA = a.items[0]?.id as string;

    const entry = await withTenant(co, (tx) => addNote(tx, c, { id: a.order.id, text: TEXT }));
    expect(entry.message).toBe(TEXT);
    await withTenant(co, (tx) =>
      setItemFlag(tx, c, { id: itemA, code: "address_check", active: true, note: TEXT }),
    );
    await withTenant(co, (tx) =>
      holdOrder(tx, c, { id: a.order.id, reason: "address_check", note: TEXT }),
    );
    await withTenant(co, (tx) =>
      cancelOrder(tx, c, { id: b.order.id, reason: "buyer_request", note: TEXT }),
    );

    for (const [name, rows] of [
      ["audit_log", await auditOf(co)],
      [
        "order_item_transitions",
        await withTenant(co, (tx) => tx.select().from(orderItemTransitions)),
      ],
    ] as const) {
      expect(JSON.stringify(rows), name).not.toContain("Quimby");
      expect(JSON.stringify(rows), name).not.toContain("555-0199");
    }

    const tl = await withTenant(co, (tx) => timeline(tx, c, { id: a.order.id, limit: 50 }));
    const msgs = tl.items.map((e) => e.message);
    expect(msgs).toContain(TEXT);
    expect(msgs).toContain(`Held (address check): ${TEXT}`);
    expect(msgs).toContain(`Flagged address check: ${TEXT}`);
    const tlB = await withTenant(co, (tx) => timeline(tx, c, { id: b.order.id, limit: 50 }));
    expect(
      tlB.items.some(
        (e) => e.message.startsWith("Order cancelled (buyer request)") && e.message.endsWith(TEXT),
      ),
    ).toBe(true);
    // the staff note rows are the only copy
    const noteRows = await withTenant(co, (tx) => tx.select().from(orderNotes));
    expect(noteRows.map((n) => n.kind).sort()).toEqual(["cancel", "flag", "hold", "note"]);
    // a purged note leaves the fixed phrase in the timeline
    await withTenant(co, (tx) => tx.delete(orderNotes));
    const gone = await withTenant(co, (tx) => timeline(tx, c, { id: a.order.id, limit: 50 }));
    expect(gone.items.map((e) => e.message)).toContain("Note added");
    expect(gone.items.map((e) => e.message).join("|")).not.toContain("Quimby");

    // a role without orders.manage cannot hold or cancel (the guard reads this table)
    expect(ROLE_PERMISSIONS.presser).not.toContain("orders.manage");
  });

  it("another company never sees the note: timeline NOT_FOUND, rows invisible under RLS", async () => {
    const coA = (await createCompany()).id;
    const coB = (await createCompany()).id;
    const connA = await createConnection(coA, "shopify");
    const uA = await createUser(coA, "office");
    const uB = await createUser(coB, "office");
    const cA = tenantContext(coA, uA.id, "office");
    const cB = tenantContext(coB, uB.id, "office");
    const o = await createOrder(coA, connA.id, { units: 1, state: "ready" });
    await withTenant(coA, (tx) => addNote(tx, cA, { id: o.order.id, text: TEXT }));
    await expect(
      withTenant(coB, (tx) => timeline(tx, cB, { id: o.order.id, limit: 50 })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await withTenant(coB, (tx) => tx.select().from(orderNotes))).toEqual([]);
  });
});
