import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  channelConnections,
  inventoryMovements,
  listings,
  listingVariants,
  purchaseOrders,
} from "../../db/schema";
import * as channelsModule from "../../integrations/channels";
import type { ChannelAdapter } from "../../integrations/channels/types";
import type { SupplierAdapter, SupplierOrderLookup } from "../../integrations/suppliers";
import * as suppliersModule from "../../integrations/suppliers";
import { runJobInline } from "../../lib/queues";
import { createCompany, createLocation, createUser, tenantContext } from "../../test/fixtures";
import * as sku from "../channels/sku";
import { type ConnectionPushPlan, planAvailability, pushAvailability } from "./availability";
import { pushAvailabilityJob } from "./jobs";
import { recordMovement } from "./ledger";
import * as svc from "./service";

/*
 * T-20-3 (B-71) AC2, inventory: the cases po-safety and availability don't cover. A concurrent
 * double submit orders once; a concurrent double receipt under one key counts once; an
 * availability push whose channel call landed but whose commit failed is retried under the
 * same idempotency key (Shopify dedupes it) and stores the pushed quantity once.
 */

vi.mock("../../integrations/suppliers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/suppliers")>();
  return { ...actual, getSupplierAdapter: vi.fn(actual.getSupplierAdapter) };
});
vi.mock("../../integrations/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/channels")>();
  return { ...actual, getChannelAdapter: vi.fn(actual.getChannelAdapter) };
});
vi.mock("../channels/sku", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/sku")>();
  return { ...actual, markAvailabilityPushed: vi.fn(actual.markAvailabilityPushed) };
});

type FakeSupplier = SupplierAdapter & {
  placed: Map<string, SupplierOrderLookup>;
  calls: { place: number; find: number };
};

function fakeSupplier(): FakeSupplier {
  const fake: FakeSupplier = {
    provider: "live",
    placed: new Map(),
    calls: { place: 0, find: 0 },
    async stock() {
      return [];
    },
    async products() {
      return [];
    },
    async placeOrder(input) {
      fake.calls.place += 1;
      // Hold the call open so a second submit really overlaps it.
      await new Promise((r) => setTimeout(r, 150));
      const result = { supplierOrderId: `SS-${fake.calls.place}`, expectedAt: null };
      fake.placed.set(input.poNo, { ...result, cancelled: false });
      return result;
    },
    async findOrder(poNo) {
      fake.calls.find += 1;
      return fake.placed.get(poNo) ?? null;
    },
  };
  return fake;
}

const code = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" ? ((r.reason as { code?: string }).code ?? "ERROR") : "ok";

describe("T-20-3 inventory side effects", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let locationId: string;
  let blankIds: string[];
  let supplier: FakeSupplier;
  const setAvailability = vi.fn<ChannelAdapter["setAvailability"]>();

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    locationId = (await createLocation(companyId)).id;
    const rows = await withSystem((tx) =>
      tx
        .insert(blankVariants)
        .values(
          ["S", "M"].map((size) => ({
            companyId,
            brand: "Gildan",
            style: "Softstyle",
            styleCode: "G64000",
            color: "Black",
            colorCode: "BLK",
            size,
            sizeCode: size,
            sku: `T203-BLK-${size}`,
            supplierSku: `B203${size}`,
            costCents: 300,
          })),
        )
        .returning(),
    );
    blankIds = rows.map((r) => r.id);
  });

  beforeEach(() => {
    supplier = fakeSupplier();
    vi.mocked(suppliersModule.getSupplierAdapter).mockImplementation(async () => supplier);
    setAvailability.mockReset();
    vi.mocked(sku.markAvailabilityPushed).mockClear();
    vi.mocked(channelsModule.getChannelAdapter).mockImplementation(
      async (kind) =>
        ({ channel: kind, pendingApproval: false, setAvailability }) as unknown as ChannelAdapter,
    );
  });

  const draftPo = () =>
    withTenant(companyId, (tx) =>
      svc.createPo(tx, ctx, {
        supplier: "ssactivewear",
        lines: blankIds.map((id) => ({ blankVariantId: id, qty: 10 })),
        freight: 0,
        expectedAt: null,
        notes: null,
      }),
    );

  const poRow = async (id: string) => {
    const [r] = await withSystem((tx) =>
      tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)),
    );
    if (!r) throw new Error("po missing");
    return r;
  };

  it("submitPo: a concurrent double submit orders once; the loser is told it's in flight", async () => {
    const po = await draftPo();
    const results = await Promise.allSettled([svc.submitPo(ctx, po.id), svc.submitPo(ctx, po.id)]);
    expect(supplier.calls.place).toBe(1);
    const codes = results.map(code).sort();
    expect(codes).toEqual(["CONFLICT", "ok"]);
    expect(await poRow(po.id)).toMatchObject({
      status: "submitted",
      supplierOrderId: "SS-1",
      submitAttemptedAt: null,
    });
    // Afterwards a repeat is the stored result.
    expect((await svc.submitPo(ctx, po.id)).supplierOrderId).toBe("SS-1");
    expect(supplier.calls.place).toBe(1);
  });

  it("receivePo: a concurrent double receipt under one key counts the stock once", async () => {
    const po = await svc.submitPo(ctx, (await draftPo()).id);
    const line = po.lines[0];
    if (!line) throw new Error("no line");
    const before = (
      await withTenant(companyId, (tx) =>
        svc.getStock(tx, ctx, { blankVariantId: line.blankVariantId }),
      )
    ).onHand;
    const receipt = {
      purchaseOrderId: po.id,
      lines: [{ lineId: line.id, qty: 4 }],
      note: null,
      idempotencyKey: `rcpt-t203-${po.id}`,
    };
    const results = await Promise.allSettled([
      withTenant(companyId, (tx) => svc.receivePo(tx, ctx, receipt)),
      withTenant(companyId, (tx) => svc.receivePo(tx, ctx, receipt)),
    ]);
    // Both answer with the PO as received once; a loser may at worst see CONFLICT, never a double count.
    expect(results.map(code).every((c) => c === "ok" || c === "CONFLICT")).toBe(true);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const after = await withTenant(companyId, (tx) =>
      svc.getStock(tx, ctx, { blankVariantId: line.blankVariantId }),
    );
    expect(after.onHand).toBe(before + 4);
    const [moves] = await withSystem((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(inventoryMovements)
        .where(eq(inventoryMovements.refId, po.id)),
    );
    expect(moves?.n).toBe(1);
    expect(
      (await withTenant(companyId, (tx) => svc.getPo(tx, ctx, po.id))).lines.find(
        (l) => l.id === line.id,
      )?.receivedQty,
    ).toBe(4);
  });

  describe("syncAvailability push", () => {
    async function shopifyConnection() {
      const [row] = await withSystem((tx) =>
        tx
          .insert(channelConnections)
          .values({
            companyId,
            channel: "shopify",
            name: "Store",
            status: "connected",
            mode: "api",
            provider: "mock",
            externalShopId: `t203-${Math.random().toString(36).slice(2)}.myshopify.com`,
            settings: {
              autoImport: true,
              processingDays: null,
              riskWindowHours: 24,
              pushTracking: true,
              pushAvailability: true,
            },
          })
          .returning(),
      );
      if (!row) throw new Error("connection insert failed");
      return row;
    }

    async function variant(connectionId: string, channelSku: string, blankVariantId: string) {
      return withTenant(companyId, async (tx) => {
        const [l] = await tx
          .insert(listings)
          .values({
            companyId,
            connectionId,
            channel: "shopify",
            channelListingId: `L-${channelSku}`,
            title: channelSku,
          })
          .returning();
        const [v] = await tx
          .insert(listingVariants)
          .values({
            companyId,
            listingId: l?.id as string,
            channelVariantId: channelSku,
            channelSku,
            blankVariantId,
          })
          .returning();
        return v?.id as string;
      });
    }

    const lastPushed = async (id: string) =>
      (
        await withTenant(companyId, (tx) =>
          tx.select().from(listingVariants).where(eq(listingVariants.id, id)),
        )
      )[0]?.lastPushedQty;

    const okResults: ChannelAdapter["setAvailability"] = async (_c, updates) => ({
      updated: updates.length,
      results: updates.map((u) => ({
        listingVariantId: (u as { listingVariantId: string }).listingVariantId,
        status: "set" as const,
        available: (u as { available: number }).available,
        message: null,
      })),
    });

    it("a crash after the channel took the push retries under the same key and stores the quantity once", async () => {
      const conn = await shopifyConnection();
      const blank = blankIds[0] as string;
      const v = await variant(conn.id, `CRASH-${conn.id.slice(0, 6)}`, blank);
      await withTenant(companyId, (tx) =>
        recordMovement(tx, ctx, {
          blankVariantId: blank,
          locationId,
          kind: "adjust",
          qty: 3,
          reason: "found",
        }),
      );
      const plan = await withTenant(companyId, (tx) => planAvailability(tx, companyId));
      const push = {
        companyId,
        idempotencyKey: `push-t203-${conn.id}`,
        ...(plan.pushes.find((p) => p.connectionId === conn.id) as ConnectionPushPlan),
      };
      expect(push.updates.map((u) => u.listingVariantId)).toContain(v);

      setAvailability.mockImplementation(okResults);
      vi.mocked(sku.markAvailabilityPushed).mockImplementationOnce(async () => {
        throw new Error("simulated commit failure");
      });
      await expect(runJobInline(pushAvailabilityJob, push)).rejects.toThrow(/simulated/);
      expect(setAvailability).toHaveBeenCalledTimes(1);
      expect(await lastPushed(v)).toBeNull();

      await runJobInline(pushAvailabilityJob, push);
      expect(setAvailability).toHaveBeenCalledTimes(2);
      const keys = setAvailability.mock.calls.map((c) => c[2]?.idempotencyKey);
      expect(keys).toEqual([push.idempotencyKey, push.idempotencyKey]);
      const expected = push.updates.find((u) => u.listingVariantId === v)?.available;
      expect(await lastPushed(v)).toBe(expected);

      // Settled: a replay of the same push touches neither the channel nor the row.
      await runJobInline(pushAvailabilityJob, push);
      expect(setAvailability).toHaveBeenCalledTimes(2);
      await withSystem((tx) =>
        tx.delete(channelConnections).where(eq(channelConnections.id, conn.id)),
      );
    });

    it("two concurrent runs of one push carry the same key, so the channel dedupes them", async () => {
      const conn = await shopifyConnection();
      const blank = blankIds[1] as string;
      const v = await variant(conn.id, `TWICE-${conn.id.slice(0, 6)}`, blank);
      await withTenant(companyId, (tx) =>
        recordMovement(tx, ctx, {
          blankVariantId: blank,
          locationId,
          kind: "adjust",
          qty: 2,
          reason: "found",
        }),
      );
      const plan = await withTenant(companyId, (tx) => planAvailability(tx, companyId));
      const push = {
        companyId,
        idempotencyKey: `push-t203-twice-${conn.id}`,
        ...(plan.pushes.find((p) => p.connectionId === conn.id) as ConnectionPushPlan),
      };
      setAvailability.mockImplementation(async (c, updates, opts) => {
        await new Promise((r) => setTimeout(r, 100));
        return okResults(c, updates, opts);
      });
      const [a, b] = await Promise.all([pushAvailability(push), pushAvailability(push)]);
      expect(a.pushed + b.pushed).toBeGreaterThanOrEqual(1);
      const keys = setAvailability.mock.calls.map((c) => c[2]?.idempotencyKey);
      expect(new Set(keys)).toEqual(new Set([push.idempotencyKey]));
      expect(await lastPushed(v)).toBe(
        push.updates.find((u) => u.listingVariantId === v)?.available,
      );
      await withSystem((tx) =>
        tx.delete(channelConnections).where(eq(channelConnections.id, conn.id)),
      );
    });
  });
});
