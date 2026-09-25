import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../api/context";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  channelConnections,
  listings,
  listingVariants,
  stockLevels,
} from "../../db/schema";
import * as channelsModule from "../../integrations/channels";
import type { ChannelAdapter } from "../../integrations/channels/types";
import { runJobInline } from "../../lib/queues";
import * as realtime from "../../lib/realtime";
import { createCompany, createLocation, createUser, tenantContext } from "../../test/fixtures";
import {
  type ConnectionPushPlan,
  canPushAvailability,
  planAvailability,
  pushAvailability,
  pushQuantity,
} from "./availability";
import {
  AVAILABILITY_DEBOUNCE_MS,
  availabilityBucket,
  pushAvailabilityJob,
  scheduleAvailabilitySync,
  syncAvailabilityJob,
} from "./jobs";
import { recordMovement } from "./ledger";
import * as svc from "./service";

vi.mock("../../integrations/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/channels")>();
  return { ...actual, getChannelAdapter: vi.fn(actual.getChannelAdapter) };
});
vi.mock("../../lib/realtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/realtime")>();
  return { ...actual, publish: vi.fn(async () => "0-1") };
});

type SetAvailability = ChannelAdapter["setAvailability"];

const stockChangedCalls = () =>
  (
    vi.mocked(realtime.publish).mock.calls as unknown as [
      string,
      string,
      { blankVariantId: string; locationId: string; available: number },
    ][]
  ).filter((c) => c[1] === "stock.changed");
const setAvailability = vi.fn<SetAvailability>();

/** A mock Shopify whose setAvailability is observable; every other call is the real mock. */
function useFakeShopify() {
  vi.mocked(channelsModule.getChannelAdapter).mockImplementation(
    (kind) =>
      ({ channel: kind, pendingApproval: false, setAvailability }) as unknown as ChannelAdapter,
  );
}

let companyId: string;
let ctx: TenantContext;
let mainLoc: string;
let backLoc: string;
const blank: Record<string, string> = {};

async function connection(
  settings: { pushAvailability: boolean },
  extra: Record<string, unknown> = {},
) {
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
        externalShopId: `t33-${Math.random().toString(36).slice(2)}.myshopify.com`,
        settings: {
          autoImport: true,
          processingDays: null,
          riskWindowHours: 24,
          pushTracking: true,
          pushAvailability: settings.pushAvailability,
        },
        ...extra,
      })
      .returning(),
  );
  if (!row) throw new Error("connection insert failed");
  return row;
}

async function variant(
  connectionId: string,
  sku: string,
  blankVariantId: string,
  cap: number | null = null,
) {
  return withTenant(companyId, async (tx) => {
    const [l] = await tx
      .insert(listings)
      .values({
        companyId,
        connectionId,
        channel: "shopify",
        channelListingId: `L-${sku}-${connectionId.slice(0, 6)}`,
        title: sku,
      })
      .returning();
    const [v] = await tx
      .insert(listingVariants)
      .values({
        companyId,
        listingId: l?.id as string,
        channelVariantId: sku,
        channelSku: sku,
        blankVariantId,
        quantityCap: cap,
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

const move = (
  blankVariantId: string,
  kind: "adjust" | "reserve" | "release",
  qty: number,
  locationId = mainLoc,
) =>
  withTenant(companyId, (tx) =>
    recordMovement(tx, ctx, { blankVariantId, locationId, kind, qty, reason: "found" }),
  );

beforeAll(async () => {
  companyId = (await createCompany()).id;
  const owner = await createUser(companyId, "owner");
  ctx = tenantContext(companyId, owner.id, "owner");
  mainLoc = (await createLocation(companyId)).id;
  backLoc = (await createLocation(companyId, "Back room")).id;
  const rows = await withSystem((tx) =>
    tx
      .insert(blankVariants)
      .values(
        ["S", "M", "L"].map((size) => ({
          companyId,
          brand: "Gildan",
          style: "Softstyle",
          styleCode: "G64000",
          color: "Black",
          colorCode: "BLK",
          size,
          sizeCode: size,
          sku: `G64000-BLK-${size}`,
          supplierSku: `B${size}`,
          costCents: 250,
        })),
      )
      .returning(),
  );
  for (const r of rows) blank[r.size] = r.id;
});

afterEach(() => {
  setAvailability.mockReset();
  vi.mocked(channelsModule.getChannelAdapter).mockReset();
  vi.useRealTimers();
});

describe("availability math", () => {
  it("clamps at zero and applies the cap", () => {
    expect(pushQuantity(12, null)).toBe(12);
    expect(pushQuantity(12, 5)).toBe(5);
    expect(pushQuantity(3, 5)).toBe(3);
    expect(pushQuantity(-3, null)).toBe(0);
    expect(pushQuantity(7, -1)).toBe(0);
  });

  it("is on hand minus reserved, summed over every location, then capped", async () => {
    useFakeShopify();
    const conn = await connection({ pushAvailability: true });
    const s = await variant(conn.id, "MATH-S", blank.S as string);
    const capped = await variant(conn.id, "MATH-S-CAP", blank.S as string, 4);
    await move(blank.S as string, "adjust", 10);
    await move(blank.S as string, "adjust", 5, backLoc);
    await move(blank.S as string, "reserve", 3);
    const plan = await withTenant(companyId, (tx) => planAvailability(tx, companyId));
    const updates = plan.pushes.find((p) => p.connectionId === conn.id)?.updates ?? [];
    expect(updates.find((u) => u.listingVariantId === s)).toMatchObject({
      available: 12,
      fromQty: null,
    });
    expect(updates.find((u) => u.listingVariantId === capped)?.available).toBe(4);
    await withSystem((tx) =>
      tx.delete(channelConnections).where(eq(channelConnections.id, conn.id)),
    );
  });
});

describe("opt-in gating (decision 0003)", () => {
  it("plans pushes only for connected API connections that opted in", async () => {
    useFakeShopify();
    const off = await connection({ pushAvailability: false });
    const csv = await connection({ pushAvailability: true }, { mode: "csv", status: "csv_only" });
    const gone = await connection({ pushAvailability: true }, { status: "disconnected" });
    const on = await connection({ pushAvailability: true });
    for (const c of [off, csv, gone, on])
      await variant(c.id, `GATE-${c.id.slice(0, 4)}`, blank.M as string);
    await move(blank.M as string, "adjust", 6);

    const plan = await withTenant(companyId, (tx) => planAvailability(tx, companyId));
    expect(plan.pushes.map((p) => p.connectionId)).toEqual([on.id]);
    expect(plan.skippedConnections).toBe(3);
    expect(canPushAvailability(off)).toBe(false);
    expect(canPushAvailability(on)).toBe(true);
    await withSystem((tx) =>
      tx.delete(channelConnections).where(eq(channelConnections.companyId, companyId)),
    );
  });

  it("drops a planned push when the shop turns the push off before it runs", async () => {
    useFakeShopify();
    const conn = await connection({ pushAvailability: true });
    const v = await variant(conn.id, "OFF-L", blank.L as string);
    await move(blank.L as string, "adjust", 2);
    const plan = await withTenant(companyId, (tx) => planAvailability(tx, companyId));
    await withSystem((tx) =>
      tx
        .update(channelConnections)
        .set({ settings: { ...(conn.settings as object), pushAvailability: false } as never })
        .where(eq(channelConnections.id, conn.id)),
    );
    const res = await pushAvailability({
      companyId,
      idempotencyKey: "key-off",
      ...(plan.pushes[0] as ConnectionPushPlan),
    });
    expect(res).toMatchObject({ pushed: 0, skipped: 1 });
    expect(setAvailability).not.toHaveBeenCalled();
    expect(await lastPushed(v)).toBeNull();
    await withSystem((tx) =>
      tx.delete(channelConnections).where(eq(channelConnections.id, conn.id)),
    );
  });
});

describe("pushing", () => {
  it("pushes the right number once, stores it, and doesn't push an unchanged value again", async () => {
    useFakeShopify();
    setAvailability.mockImplementation(async (_conn, updates) => ({
      updated: updates.length,
      results: updates.map((u) => ({
        listingVariantId: (u as { listingVariantId: string }).listingVariantId,
        status: "set" as const,
        available: (u as { available: number }).available,
        message: null,
      })),
    }));
    const conn = await connection({ pushAvailability: true });
    const before = await withTenant(companyId, (tx) =>
      svc.getStock(tx, ctx, { blankVariantId: blank.M as string }),
    );
    const v = await variant(conn.id, "PUSH-M", blank.M as string);
    await move(blank.M as string, "adjust", 4);
    const expected = before.available + 4;

    const enqueue = vi.spyOn(pushAvailabilityJob, "enqueue").mockResolvedValue({} as never);
    await runJobInline(syncAvailabilityJob, { companyId, bucket: 1001 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [input, opts] = enqueue.mock.calls[0] as [
      Parameters<typeof pushAvailabilityJob.enqueue>[0],
      { jobId: string },
    ];
    expect(opts.jobId).toBe(`availability-push-1001-${conn.id}`);
    expect(input.updates).toEqual([
      { listingVariantId: v, channelSku: "PUSH-M", available: expected, fromQty: null },
    ]);

    await runJobInline(pushAvailabilityJob, input);
    expect(setAvailability).toHaveBeenCalledTimes(1);
    const [, sent, sentOpts] = setAvailability.mock.calls[0] as Parameters<SetAvailability>;
    expect(sent).toEqual([{ listingVariantId: v, channelSku: "PUSH-M", available: expected }]);
    expect(sentOpts?.idempotencyKey).toBe(input.idempotencyKey);
    expect(await lastPushed(v)).toBe(expected);

    // Nothing changed: the next window plans nothing, so no push.
    enqueue.mockClear();
    await runJobInline(syncAvailabilityJob, { companyId, bucket: 1002 });
    expect(enqueue).not.toHaveBeenCalled();

    // A replay of the finished push (BullMQ retry after a lost ack) doesn't call the channel.
    await runJobInline(pushAvailabilityJob, input);
    expect(setAvailability).toHaveBeenCalledTimes(1);
    enqueue.mockRestore();
    await withSystem((tx) =>
      tx.delete(channelConnections).where(eq(channelConnections.id, conn.id)),
    );
  });

  it("a retry after a failed call resends the same push under the same key", async () => {
    useFakeShopify();
    const conn = await connection({ pushAvailability: true });
    const v = await variant(conn.id, "RETRY-S", blank.S as string);
    const plan = await withTenant(companyId, (tx) => planAvailability(tx, companyId));
    const push = {
      companyId,
      idempotencyKey: "11111111-2222-4333-8444-555555555555",
      ...(plan.pushes.find((p) => p.connectionId === conn.id) as {
        connectionId: string;
        updates: {
          listingVariantId: string;
          channelSku: string;
          available: number;
          fromQty: number | null;
        }[];
      }),
    };
    setAvailability.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(runJobInline(pushAvailabilityJob, push)).rejects.toThrow("socket hang up");
    expect(await lastPushed(v)).toBeNull();

    setAvailability.mockImplementation(async (_c, updates) => ({
      updated: updates.length,
      results: updates.map((u) => ({
        listingVariantId: (u as { listingVariantId: string }).listingVariantId,
        status: "set" as const,
        available: (u as { available: number }).available,
        message: null,
      })),
    }));
    await runJobInline(pushAvailabilityJob, push);
    expect(setAvailability).toHaveBeenCalledTimes(2);
    const keys = setAvailability.mock.calls.map((c) => c[2]?.idempotencyKey);
    expect(keys).toEqual([push.idempotencyKey, push.idempotencyKey]);
    expect(await lastPushed(v)).toBe(push.updates.find((u) => u.listingVariantId === v)?.available);
    await withSystem((tx) =>
      tx.delete(channelConnections).where(eq(channelConnections.id, conn.id)),
    );
  });

  it("keeps variants the channel couldn't find unpushed, so they go again next time", async () => {
    useFakeShopify();
    setAvailability.mockImplementation(async (_c, updates) => ({
      updated: 0,
      results: updates.map((u) => ({
        listingVariantId: (u as { listingVariantId: string }).listingVariantId,
        status: "not_found" as const,
        available: null,
        message: "No Shopify variant with SKU",
      })),
    }));
    const conn = await connection({ pushAvailability: true });
    const v = await variant(conn.id, "GHOST-S", blank.S as string);
    const plan = await withTenant(companyId, (tx) => planAvailability(tx, companyId));
    const p = plan.pushes.find((x) => x.connectionId === conn.id);
    const res = await pushAvailability({
      companyId,
      idempotencyKey: "k-ghost",
      ...(p as ConnectionPushPlan),
    });
    expect(res).toMatchObject({ pushed: 0, notFound: 1 });
    expect(await lastPushed(v)).toBeNull();
    await withSystem((tx) =>
      tx.delete(channelConnections).where(eq(channelConnections.id, conn.id)),
    );
  });
});

describe("debounce (30 s windows)", () => {
  it("changes inside one window share one delayed job; the next window gets its own", async () => {
    const t0 = 1_790_000_000_000;
    const start = t0 - (t0 % AVAILABILITY_DEBOUNCE_MS); // a window boundary
    const a = availabilityBucket(start + 1_000);
    const b = availabilityBucket(start + 29_000);
    const c = availabilityBucket(start + 30_000);
    expect(a.bucket).toBe(b.bucket);
    expect(a.delay).toBe(29_000);
    expect(b.delay).toBe(1_000);
    expect(c.bucket).toBe(a.bucket + 1);
    expect(c.delay).toBe(30_000);

    const enqueue = vi.spyOn(syncAvailabilityJob, "enqueue").mockResolvedValue({} as never);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start + 5_000);
    await runJobInline(scheduleAvailabilitySync, { companyId });
    vi.setSystemTime(start + 20_000);
    await runJobInline(scheduleAvailabilitySync, { companyId });
    const ids = enqueue.mock.calls.map((call) =>
      syncAvailabilityJob.jobId?.(call[0] as { companyId: string; bucket: number }),
    );
    expect(ids[0]).toBe(ids[1]);
    expect(enqueue.mock.calls.map((call) => (call[1] as { delay: number }).delay)).toEqual([
      25_000, 10_000,
    ]);
    enqueue.mockRestore();
  });
});

describe("realtime stock.changed", () => {
  it("publishes once per blank and location after the commit, with the last count", async () => {
    vi.mocked(realtime.publish).mockClear();
    await withTenant(companyId, async (tx) => {
      await recordMovement(tx, ctx, {
        blankVariantId: blank.L as string,
        locationId: mainLoc,
        kind: "adjust",
        qty: 3,
      });
      await recordMovement(tx, ctx, {
        blankVariantId: blank.L as string,
        locationId: mainLoc,
        kind: "reserve",
        qty: 1,
      });
      await recordMovement(tx, ctx, {
        blankVariantId: blank.L as string,
        locationId: backLoc,
        kind: "adjust",
        qty: 2,
      });
      expect(realtime.publish).not.toHaveBeenCalled();
    });
    const calls = stockChangedCalls();
    expect(calls).toHaveLength(2);
    const [level] = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(stockLevels)
        .where(
          and(
            eq(stockLevels.blankVariantId, blank.L as string),
            eq(stockLevels.locationId, mainLoc),
          ),
        ),
    );
    const main = calls.find((c) => c[2].locationId === mainLoc);
    expect(main?.[2]).toEqual({
      blankVariantId: blank.L,
      locationId: mainLoc,
      available: level?.available,
    });
  });

  it("doesn't publish when the transaction rolls back", async () => {
    vi.mocked(realtime.publish).mockClear();
    await expect(
      withTenant(companyId, async (tx) => {
        await recordMovement(tx, ctx, {
          blankVariantId: blank.L as string,
          locationId: mainLoc,
          kind: "adjust",
          qty: 1,
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(stockChangedCalls()).toHaveLength(0);
  });
});
