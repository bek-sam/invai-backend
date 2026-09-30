import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import { companies, designs, listings, marketSignals, orderItems, orders } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { designLifecycle } from "./design-service";

/*
 * T-A5 `analytics.designLifecycle` against invai_test with RLS on. One shop (A) gets one design
 * per stage, dated relative to a frozen `asOf` of 2026-06-01 (shop tz UTC); a second shop (B)
 * gets its own designs that must never show up in A's numbers.
 */

const ASOF = "2026-06-01";
const day = (s: string) => new Date(`${s}T00:00:00Z`);

type Shop = Awaited<ReturnType<typeof seedShop>>;

async function seedShop() {
  const company = await createCompany();
  const companyId = company.id;
  await withSystem((tx) =>
    tx.update(companies).set({ timezone: "UTC" }).where(eq(companies.id, companyId)),
  );
  const owner = await createUser(companyId, "owner");
  const ctx = tenantContext(companyId, owner.id, "owner");
  const connectionId = (await createConnection(companyId, "etsy")).id;

  const mkDesign = async (name: string) => {
    const [d] = await withSystem((tx) =>
      tx
        .insert(designs)
        .values({ companyId, code: `D-${Math.random().toString(36).slice(2)}`, name })
        .returning(),
    );
    if (!d) throw new Error("seed failed");
    return d;
  };

  const saleAt = async (designId: string, placedAt: Date) => {
    const { order, items } = await createOrder(companyId, connectionId, { units: 1 });
    const item = items[0];
    if (!item) throw new Error("seed failed");
    await withSystem((tx) => tx.update(orders).set({ placedAt }).where(eq(orders.id, order.id)));
    await withSystem((tx) =>
      tx.update(orderItems).set({ designId, state: "packed" }).where(eq(orderItems.id, item.id)),
    );
  };

  const listActive = async (designId: string) => {
    await withSystem((tx) =>
      tx.insert(listings).values({
        companyId,
        connectionId,
        channel: "etsy",
        channelListingId: `L-${Math.random().toString(36).slice(2)}`,
        title: "Listing",
        state: "active",
        designId,
      }),
    );
  };

  // dead: active listing, no sale in the last 60 days (last sale 2026-01-01).
  const dead = await mkDesign("Dead Design");
  await saleAt(dead.id, day("2026-01-01"));
  await listActive(dead.id);

  // new: first sale inside the last 8 weeks (2026-05-20), no listing.
  const fresh = await mkDesign("New Design");
  await saleAt(fresh.id, day("2026-05-20"));

  // growing: u4 (2026-05-04..06-01) >= 3 and >= 1.25x p4 (2026-04-06..05-04); old first sale.
  const growing = await mkDesign("Growing Design");
  await saleAt(growing.id, day("2025-10-01"));
  for (let i = 0; i < 4; i++) await saleAt(growing.id, day("2026-04-10"));
  for (let i = 0; i < 6; i++) await saleAt(growing.id, day("2026-05-10"));

  // declining: p4 >= 3 and u4 <= 0.75x p4; old first sale.
  const declining = await mkDesign("Declining Design");
  await saleAt(declining.id, day("2025-10-01"));
  for (let i = 0; i < 6; i++) await saleAt(declining.id, day("2026-04-10"));
  for (let i = 0; i < 2; i++) await saleAt(declining.id, day("2026-05-10"));

  // steady: last sale inside 60 days, too few units for growing/declining, old first sale.
  const steady = await mkDesign("Steady Design");
  await saleAt(steady.id, day("2025-10-01"));
  await saleAt(steady.id, day("2026-05-25"));

  // inactive: last sale over 60 days ago, no listing (so not "dead").
  const inactive = await mkDesign("Inactive Design");
  await saleAt(inactive.id, day("2025-06-15"));

  return {
    companyId,
    ctx,
    ids: {
      dead: dead.id,
      fresh: fresh.id,
      growing: growing.id,
      declining: declining.id,
      steady: steady.id,
      inactive: inactive.id,
    },
  };
}

let a: Shop;
let b: Shop;

beforeAll(async () => {
  a = await seedShop();
  b = await seedShop();
}, 60_000);

const lifecycle = (shop: Shop, channel?: "etsy") =>
  withTenant(shop.companyId, (tx) => designLifecycle(tx, shop.ctx, { asOf: ASOF, channel }));

describe("analytics.designLifecycle", () => {
  it("assigns the first matching stage, in order (design_lifecycle_stage.md)", async () => {
    const r = await lifecycle(a);
    const stageOf = (id: string) => r.rows.find((x) => x.designId === id)?.stage;
    expect(stageOf(a.ids.dead)).toBe("dead");
    expect(stageOf(a.ids.fresh)).toBe("new");
    expect(stageOf(a.ids.growing)).toBe("growing");
    expect(stageOf(a.ids.declining)).toBe("declining");
    expect(stageOf(a.ids.steady)).toBe("steady");
    expect(stageOf(a.ids.inactive)).toBe("inactive");
  });

  it("carries units4w / unitsPrior4w and hasActiveListing", async () => {
    const r = await lifecycle(a);
    const growing = r.rows.find((x) => x.designId === a.ids.growing);
    expect(growing).toMatchObject({ units4w: 6, unitsPrior4w: 4, hasActiveListing: false });
    const dead = r.rows.find((x) => x.designId === a.ids.dead);
    expect(dead).toMatchObject({ hasActiveListing: true, marketTrend: null });
  });

  it("stageCounts summarizes designs and units4w per stage", async () => {
    const r = await lifecycle(a);
    const growing = r.stageCounts.find((c) => c.stage === "growing");
    expect(growing).toMatchObject({ designs: 1, units4w: 6 });
    expect(r.stageCounts.reduce((s, c) => s + c.designs, 0)).toBe(r.rows.length);
  });

  it("a market trend for the design wins over the lifecycle-only stage (AC-C4)", async () => {
    await withSystem((tx) =>
      tx.insert(marketSignals).values({
        companyId: a.companyId,
        subjectType: "design",
        subjectId: a.ids.dead,
        signal: "trend",
        source: "own",
        value: { trend: "rising", g4: 0.22, windowWeeks: 26, insufficientReason: null },
        n: 20,
        sampleFactor: 1,
        reliability: 1,
        agreement: 1,
        licence: "first_party",
        mock: false,
        asOf: day("2026-05-30"),
        fetchedAt: day("2026-05-30"),
        computedOn: "2026-05-30",
      }),
    );
    const r = await lifecycle(a);
    const dead = r.rows.find((x) => x.designId === a.ids.dead);
    // rising maps to "growing" and wins over the design's own "dead" read.
    expect(dead).toMatchObject({ stage: "growing", marketTrend: "rising", marketGrowth4w: 0.22 });
    await withSystem((tx) =>
      tx.delete(marketSignals).where(eq(marketSignals.companyId, a.companyId)),
    );
  });

  it("hasEnoughHistory is false for a brand-new shop (AC-B/C-screen1)", async () => {
    const fresh = await createCompany();
    const owner = await createUser(fresh.id, "owner");
    const ctx = tenantContext(fresh.id, owner.id, "owner");
    const r = await withTenant(fresh.id, (tx) => designLifecycle(tx, ctx, { asOf: ASOF }));
    expect(r.hasEnoughHistory).toBe(false);
    expect(r.rows).toEqual([]);
    expect((await lifecycle(a)).hasEnoughHistory).toBe(true);
  });

  it("defaults asOf to today in the shop's time zone when omitted", async () => {
    const r = await withTenant(a.companyId, (tx) => designLifecycle(tx, a.ctx, {}));
    expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is a pure read: calling it twice gives the same result", async () => {
    const one = await lifecycle(a);
    const two = await lifecycle(a);
    expect(two).toEqual(one);
  });

  it("tenant isolation: A's rows never include B's designs (AC-E4)", async () => {
    const ra = await lifecycle(a);
    const rb = await lifecycle(b);
    expect(ra.rows.length).toBe(rb.rows.length);
    const json = JSON.stringify(ra);
    for (const id of Object.values(b.ids)) expect(json).not.toContain(id);
  });

  it("the owner reaches the service through the router; a role without finance.read gets FORBIDDEN (AC-E5)", async () => {
    const owner = await createUser(a.companyId, "owner");
    const ownerCtx = {
      ...anonymousContext(new Headers(), null),
      sessionKind: "user" as const,
      user: { id: owner.id, name: owner.name, email: owner.email },
      companyId: a.companyId,
      orgType: "shop" as const,
      role: "owner" as const,
      permissions: permissionsFor("owner"),
    };
    const r = await call(router.analytics.designLifecycle, { asOf: ASOF }, { context: ownerCtx });
    expect(r.rows.length).toBeGreaterThan(0);

    const packer = await createUser(a.companyId, "packer");
    const context = {
      ...ownerCtx,
      user: { id: packer.id, name: packer.name, email: packer.email },
      role: "packer" as const,
      permissions: permissionsFor("packer"),
    };
    await expect(
      call(router.analytics.designLifecycle, { asOf: ASOF }, { context }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { permission: "finance.read" },
    });
  });
});
