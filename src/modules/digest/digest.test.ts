import type { Channel, Role } from "@invai/contracts";
import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  channelConnections,
  companies,
  designs,
  digestDeliveries,
  digestInsights,
  digests,
  emailSends,
  locations,
  orderItems,
  orders,
  profitLines,
  stockLevels,
} from "../../db/schema";
import { getLinkHandler } from "../../lib/links";
import { setEmailPreference } from "../../lib/notify";
import { redis, runJobInline } from "../../lib/queues";
import { createCompany, createUser } from "../../test/fixtures";
import { getProfit } from "../finance/service";
import { buildDigest } from "./build";
import { deliverDigest } from "./deliver";
import { buildJob, deliverJob, dueShops, purgeJob, sweep } from "./jobs";

/*
 * Digest module against invai_test (RLS on). Times are passed explicitly (`at`), never read from
 * the clock: Phoenix is UTC-7 all year, so Monday 07:05 local = 14:05Z.
 */

const DAY = 86_400_000;
const uniq = () => crypto.randomUUID().slice(0, 8);
const at = (iso: string) => new Date(iso);

type Shop = Awaited<ReturnType<typeof shop>>;

async function shop(input: { timezone?: string; name?: string } = {}) {
  const company = await createCompany({ name: input.name ?? `T-19-3 Tees ${uniq()}` });
  if (input.timezone)
    await withSystem((tx) =>
      tx.update(companies).set({ timezone: input.timezone }).where(eq(companies.id, company.id)),
    );
  const owner = await createUser(company.id, "owner");
  const office = await createUser(company.id, "office");
  const [etsy] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId: company.id,
        channel: "etsy",
        name: "Etsy",
        status: "connected",
        mode: "api",
        provider: "mock",
        connectedAt: new Date(),
      })
      .returning(),
  );
  if (!etsy) throw new Error("connection");
  return { id: company.id, owner, office, etsy };
}

function ctxAs(companyId: string, user: { id: string; name: string; email: string }, role: Role) {
  return {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user" as const,
    user,
    companyId,
    orgType: "shop" as const,
    role,
    permissions: permissionsFor(role),
  };
}

async function sale(
  s: Shop,
  placedAt: Date,
  input: {
    netCents?: number;
    revenueCents?: number;
    status?: "new" | "shipped" | "cancelled";
    isReprint?: boolean;
    withProfit?: boolean;
    designId?: string;
    channel?: Channel;
  } = {},
) {
  const revenue = input.revenueCents ?? 2_500;
  const net = input.netCents ?? 1_000;
  return withSystem(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        companyId: s.id,
        connectionId: s.etsy.id,
        channel: input.channel ?? "etsy",
        channelOrderId: `o-${uniq()}`,
        orderNo: `T-${uniq()}`,
        status: input.status ?? "new",
        placedAt,
        shipBy: new Date(placedAt.getTime() + 2 * DAY),
        subtotalCents: revenue,
        totalCents: revenue,
        itemCount: 1,
      })
      .returning();
    if (!order) throw new Error("order");
    const [item] = await tx
      .insert(orderItems)
      .values({
        companyId: s.id,
        orderId: order.id,
        channelSku: `SKU-${uniq()}`,
        title: "Tee",
        state: input.status === "cancelled" ? "cancelled" : "packed",
        shipBy: order.shipBy,
        isReprint: input.isReprint ?? false,
        designId: input.designId,
      })
      .returning();
    if (!item) throw new Error("item");
    if (input.withProfit !== false && input.status !== "cancelled")
      await tx.insert(profitLines).values({
        companyId: s.id,
        orderId: order.id,
        orderItemId: item.id,
        channel: input.channel ?? "etsy",
        revenueCents: revenue,
        netCents: net,
        marginPct: revenue ? net / revenue : null,
        isReprint: input.isReprint ?? false,
        placedAt,
        designId: input.designId,
      });
    return order;
  });
}

const W39_FROM = at("2026-09-21T07:00:00.000Z");
const W39_TO = at("2026-09-28T07:00:00.000Z");
const MON_0705 = at("2026-09-28T14:05:00.000Z");

async function digestRow(companyId: string, weekKey: string) {
  const [row] = await withSystem((tx) =>
    tx
      .select()
      .from(digests)
      .where(and(eq(digests.companyId, companyId), eq(digests.weekKey, weekKey))),
  );
  return row;
}

describe("build: idempotent, parity with the profit page (AC1, AC2)", () => {
  let s: Shop;
  beforeAll(async () => {
    s = await shop();
    await sale(s, new Date(W39_FROM.getTime() + DAY), { netCents: 1_500, revenueCents: 3_000 });
    await sale(s, new Date(W39_FROM.getTime() + 3 * DAY), { netCents: 900, revenueCents: 2_000 });
    await sale(s, new Date(W39_FROM.getTime() - 3 * DAY), { netCents: 5_000, revenueCents: 9_000 });
  });

  it("the sweep builds one ready digest whose net equals getProfit's net for the week", async () => {
    await sweep(MON_0705);
    const row = await digestRow(s.id, "2026-W39");
    expect(row?.status).toBe("ready");
    expect(row?.periodFrom.toISOString()).toBe(W39_FROM.toISOString());
    expect(row?.periodTo.toISOString()).toBe(W39_TO.toISOString());
    const expected = await withTenant(s.id, (tx) =>
      getProfit(
        tx,
        { companyId: s.id },
        {
          dimension: "day",
          period: { from: W39_FROM.toISOString(), to: W39_TO.toISOString() },
        },
      ),
    );
    const owner = ctxAs(s.id, s.owner, "owner");
    const d = await call(router.digest.get, { weekKey: "2026-W39" }, { context: owner });
    // Net is revenue minus the cost buckets (finance), so only this week's two sales count.
    expect(expected.totals.revenue).toBe(5_000);
    expect(d.net?.value).toBe(expected.totals.net);
    expect(d.status).toBe("ready");
    expect(d.narrativeStatus).toBeDefined();
    expect(Object.keys(d)).not.toContain("narrative");
  });

  it("sweep twice, the build job twice: one digest, same insights", async () => {
    const before = await withSystem((tx) =>
      tx.select().from(digestInsights).where(eq(digestInsights.companyId, s.id)),
    );
    await sweep(MON_0705);
    await runJobInline(buildJob, { companyId: s.id, weekKey: "2026-W39" });
    await runJobInline(buildJob, { companyId: s.id, weekKey: "2026-W39" });
    const rows = await withSystem((tx) =>
      tx.select().from(digests).where(eq(digests.companyId, s.id)),
    );
    expect(rows).toHaveLength(1);
    const after = await withSystem((tx) =>
      tx.select().from(digestInsights).where(eq(digestInsights.companyId, s.id)),
    );
    expect(after.map((i) => i.id).sort()).toEqual(before.map((i) => i.id).sort());
    expect(await dueShops(MON_0705, null, 5_000)).not.toContainEqual(
      expect.objectContaining({ companyId: s.id }),
    );
  });
});

describe("schedule: slot, hour setting, DST computed in the database (AC3, AC5)", () => {
  it("not before 07:00 local; a shop set to 09:00 waits until 09:00", async () => {
    const a = await shop();
    const b = await shop();
    await call(router.digest.settings.set, { hour: 9 }, { context: ctxAs(b.id, b.owner, "owner") });
    const due = async (t: Date) =>
      (await dueShops(t, null, 5_000)).filter((d) => d.companyId === a.id || d.companyId === b.id);
    expect(await due(at("2026-09-28T13:55:00.000Z"))).toEqual([]);
    expect((await due(MON_0705)).map((d) => d.companyId)).toEqual([a.id]);
    expect((await due(at("2026-09-28T16:05:00.000Z"))).map((d) => d.companyId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect((await due(MON_0705))[0]?.weekKey).toBe("2026-W39");
  });

  it("New York across both DST changes: 07:00 local, not an hour off", async () => {
    const ny = await shop({ timezone: "America/New_York" });
    const has = async (t: string) =>
      (await dueShops(at(t), null, 5_000)).find((d) => d.companyId === ny.id);
    // First Monday after the fall-back (EST, UTC-5): 07:00 local = 12:00Z.
    expect(await has("2026-11-02T11:55:00.000Z")).toBeUndefined();
    expect((await has("2026-11-02T12:05:00.000Z"))?.weekKey).toBe("2026-W44");
    // First Monday after spring-forward (EDT, UTC-4): 07:00 local = 11:00Z.
    expect(await has("2026-03-09T10:55:00.000Z")).toBeUndefined();
    expect((await has("2026-03-09T11:05:00.000Z"))?.weekKey).toBe("2026-W10");
    await sweep(at("2026-11-02T12:05:00.000Z"));
    const row = await digestRow(ny.id, "2026-W44");
    // Week bounds are local midnights: EDT on Oct 26 (04:00Z), EST on Nov 2 (05:00Z).
    expect(row?.periodFrom.toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(row?.periodTo.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("sample workspaces, vendor orgs, soft-deleted and disabled shops are skipped", async () => {
    const sample = await shop();
    const deleted = await shop();
    const disabled = await shop();
    const owner = await createUser(sample.id, "admin");
    await withSystem(async (tx) => {
      await tx
        .update(companies)
        .set({ demoOwnerUserId: owner.id })
        .where(eq(companies.id, sample.id));
      await tx.update(companies).set({ deletedAt: new Date() }).where(eq(companies.id, deleted.id));
    });
    await call(
      router.digest.settings.set,
      { enabled: false },
      { context: ctxAs(disabled.id, disabled.owner, "owner") },
    );
    const vendor = await createCompany({ type: "vendor" });
    const ids = (await dueShops(MON_0705, null, 5_000)).map((d) => d.companyId);
    for (const id of [sample.id, deleted.id, disabled.id, vendor.id]) expect(ids).not.toContain(id);
  });
});

describe("content (AC6, AC7, AC9, AC10)", () => {
  it("D6: overdue open orders give an action whose count equals a hand SQL count", async () => {
    const s = await shop();
    for (let i = 0; i < 3; i++)
      await sale(s, new Date(W39_FROM.getTime() + 2 * DAY + i * 3_600_000));
    await sale(s, new Date(W39_FROM.getTime() + 2 * DAY), { status: "shipped" });
    await buildDigest(s.id, "2026-W39", MON_0705);
    const d = await call(
      router.digest.get,
      { weekKey: "2026-W39" },
      { context: ctxAs(s.id, s.owner, "owner") },
    );
    const d6 = d.actions.find((a) => a.detector === "D6");
    const [hand] = await withSystem((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(orders)
        .where(
          and(
            eq(orders.companyId, s.id),
            sql`${orders.status} in ('new','needs_attention','in_production','ready_to_ship','on_hold')`,
            sql`${orders.shipBy} < ${MON_0705.toISOString()}::timestamptz`,
          ),
        ),
    );
    expect(hand?.n).toBe(3);
    expect(d6?.facts.find((f) => f.id === "d6.overdueNow")?.value).toBe(3);
    expect(d6?.action.href).toBe("/orders?view=overdue&channel=etsy");
  });

  it("D1: a connection in error is ranked first and its channel is partial", async () => {
    const s = await shop();
    await withSystem((tx) =>
      tx.insert(channelConnections).values({
        companyId: s.id,
        channel: "amazon",
        name: "Amazon",
        status: "error",
        mode: "api",
        provider: "mock",
      }),
    );
    await sale(s, new Date(W39_FROM.getTime() + DAY));
    await buildDigest(s.id, "2026-W39", MON_0705);
    const d = await call(
      router.digest.get,
      { weekKey: "2026-W39" },
      { context: ctxAs(s.id, s.owner, "owner") },
    );
    expect(d.actions[0]?.detector).toBe("D1");
    expect(d.actions[0]?.action).toMatchObject({
      kind: "reconnect_channel",
      href: "/settings/channels",
    });
    expect(d.partialChannels).toEqual(["amazon"]);
  });

  it("zero orders and no open issues: skipped_quiet, no delivery; paused after two weeks", async () => {
    const s = await shop();
    await setEmailPreference(s.id, s.owner.id, "digest", { on: true, source: "settings" });
    const w1 = await buildDigest(s.id, "2026-W39", MON_0705);
    expect(w1.status).toBe("skipped_quiet");
    expect(await deliverDigest(s.id, "digestId" in w1 ? w1.digestId : "", MON_0705)).toEqual({
      sent: 0,
      skipped: 0,
      waiting: false,
    });
    const owner = ctxAs(s.id, s.owner, "owner");
    expect((await call(router.digest.latest, {}, { context: owner })).paused).toBe(false);
    await buildDigest(s.id, "2026-W40", at("2026-10-05T14:05:00.000Z"));
    const latest = await call(router.digest.latest, {}, { context: owner });
    expect(latest.paused).toBe(true);
    expect(latest.digest?.weekKey).toBe("2026-W40");
    expect(latest.digest?.status).toBe("skipped_quiet");
  });

  it("AC10: a cancelled item adds nothing; a re-pressed unit is one sale with its reprint cost", async () => {
    const s = await shop();
    const inWeek = new Date(W39_FROM.getTime() + 2 * DAY);
    await sale(s, inWeek, { status: "cancelled", netCents: 9_999 });
    // Decision 0020: the reprint is the same unit re-pressed; its second transfer lowers net.
    await sale(s, inWeek, {
      isReprint: true,
      netCents: 500,
      revenueCents: 2_500,
      status: "shipped",
    });
    await buildDigest(s.id, "2026-W39", MON_0705);
    const d = await call(
      router.digest.get,
      { weekKey: "2026-W39" },
      { context: ctxAs(s.id, s.owner, "owner") },
    );
    const profit = await withTenant(s.id, (tx) =>
      getProfit(
        tx,
        { companyId: s.id },
        { dimension: "day", period: { from: W39_FROM.toISOString(), to: W39_TO.toISOString() } },
      ),
    );
    expect(d.net?.value).toBe(profit.totals.net);
    expect(d.glance.find((g) => g.metric === "revenue")?.current.value).toBe(2_500);
    // The re-pressed unit keeps its sale; the cancelled item adds none.
    expect(profit.totals.revenue).toBe(2_500);
  });
});

describe("D7 stock (AC11)", () => {
  it("names a low blank a top design sold with, linking to reorder", async () => {
    const s = await shop();
    const [d] = await withSystem((tx) =>
      tx
        .insert(designs)
        .values({ companyId: s.id, code: `D-${uniq()}`, name: "Cactus Tee", tags: [] })
        .returning(),
    );
    const variant = await withSystem(async (tx) => {
      const [v] = await tx
        .insert(blankVariants)
        .values({
          companyId: s.id,
          brand: "Gildan",
          style: "64000",
          styleCode: "G640",
          styleName: "Softstyle Tee",
          color: "Black",
          colorCode: "BLK",
          size: "L",
          sizeCode: "L",
          sku: `G640-BLK-L-${uniq()}`,
          costCents: 385,
          reorderPoint: 24,
          reorderQty: 48,
        })
        .returning();
      const [loc] = await tx
        .insert(locations)
        .values({ companyId: s.id, name: `Main ${uniq()}`, isDefault: true })
        .returning();
      if (!v || !loc) throw new Error("fixture");
      await tx.insert(stockLevels).values({
        companyId: s.id,
        blankVariantId: v.id,
        locationId: loc.id,
        onHand: 2,
        available: 2,
        reorderPoint: 24,
        reorderQty: 48,
      });
      return v;
    });
    for (let i = 0; i < 5; i++) {
      const o = await sale(s, new Date(W39_FROM.getTime() + DAY + i * 3_600_000), {
        designId: d?.id,
        status: "shipped",
      });
      await withSystem((tx) =>
        tx
          .update(profitLines)
          .set({ blankVariantId: variant.id })
          .where(eq(profitLines.orderId, o.id)),
      );
    }
    await buildDigest(s.id, "2026-W39", MON_0705);
    const got = await call(
      router.digest.get,
      { weekKey: "2026-W39" },
      { context: ctxAs(s.id, s.owner, "owner") },
    );
    const d7 = got.actions.find((a) => a.detector === "D7");
    expect(d7?.action).toMatchObject({
      kind: "reorder_blank",
      href: "/inventory/stock?low=true",
      params: {
        blankVariantId: variant.id,
        blankName: "Gildan G640 Black L",
        designName: "Cactus Tee",
      },
    });
    expect(d7?.confidence).toBe(0.9);
  });
});

describe("delivery (AC4, AC23, AC26; A7)", () => {
  it("opted-in owner gets one email, twice-run delivery sends once; others skipped with reasons", async () => {
    const s = await shop({ name: `T-19-3 Mail Tees ${uniq()}` });
    const unverified = await createUser(s.id, "admin", { emailVerified: false });
    await sale(s, new Date(W39_FROM.getTime() + DAY));
    await setEmailPreference(s.id, s.owner.id, "digest", { on: true, source: "settings" });
    await setEmailPreference(s.id, unverified.id, "digest", { on: true, source: "settings" });
    const built = await buildDigest(s.id, "2026-W39", MON_0705);
    if (!("digestId" in built)) throw new Error("no digest");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MON_0705);
    const first = await runJobInline(deliverJob, {
      companyId: s.id,
      digestId: built.digestId,
    }).finally(() => vi.useRealTimers());
    const again = await deliverDigest(s.id, built.digestId, MON_0705);
    expect(first).toMatchObject({ sent: 1 });
    expect(again).toEqual({ sent: 0, skipped: 0, waiting: false });
    const rows = await withSystem((tx) =>
      tx.select().from(digestDeliveries).where(eq(digestDeliveries.companyId, s.id)),
    );
    const by = (id: string) => rows.find((r) => r.userId === id);
    expect(rows).toHaveLength(3);
    expect(by(s.owner.id)).toMatchObject({ status: "sent", reason: null });
    expect(by(s.owner.id)?.messageId).toMatch(
      new RegExp(`^<digest\\.${built.digestId}\\.${s.owner.id}@`),
    );
    expect(by(s.office.id)).toMatchObject({ status: "skipped", reason: "opted_out" });
    expect(by(unverified.id)).toMatchObject({ status: "skipped", reason: "unverified" });
    const sends = await withSystem((tx) =>
      tx.select().from(emailSends).where(eq(emailSends.companyId, s.id)),
    );
    expect(sends.filter((x) => x.status === "sent")).toHaveLength(1);
  });

  it("AC4: built at 21:30 local → in-app only; opted-in people are skipped as quiet_hours", async () => {
    const s = await shop();
    await sale(s, new Date(W39_FROM.getTime() + DAY));
    await setEmailPreference(s.id, s.owner.id, "digest", { on: true, source: "settings" });
    const late = at("2026-09-29T04:30:00.000Z"); // Monday 21:30 Phoenix
    await sweep(late);
    const row = await digestRow(s.id, "2026-W39");
    expect(row).toMatchObject({ status: "ready", inAppOnly: true });
    const out = await deliverDigest(s.id, row?.id ?? "", late);
    expect(out.sent).toBe(0);
    const rows = await withSystem((tx) =>
      tx.select().from(digestDeliveries).where(eq(digestDeliveries.companyId, s.id)),
    );
    expect(rows.find((r) => r.userId === s.owner.id)).toMatchObject({
      status: "skipped",
      reason: "quiet_hours",
    });
  });

  it("an office user who opts in later gets the next week's email (AC23)", async () => {
    const s = await shop();
    await sale(s, new Date(W39_FROM.getTime() + DAY));
    await sale(s, new Date(W39_TO.getTime() + DAY));
    const w39 = await buildDigest(s.id, "2026-W39", MON_0705);
    await deliverDigest(s.id, "digestId" in w39 ? w39.digestId : "", MON_0705);
    await call(
      router.me.notifications.set,
      { kind: "digest", on: true },
      { context: ctxAs(s.id, s.office, "office") },
    );
    const monW41 = at("2026-10-05T14:05:00.000Z");
    const w40 = await buildDigest(s.id, "2026-W40", monW41);
    const out = await deliverDigest(s.id, "digestId" in w40 ? w40.digestId : "", monW41);
    expect(out.sent).toBe(1);
  });
});

describe("router, permissions and tenancy (AC27, AC28, AC30)", () => {
  let s: Shop;
  let other: Shop;
  beforeAll(async () => {
    s = await shop();
    other = await shop();
    await sale(s, new Date(W39_FROM.getTime() + DAY));
    for (let i = 0; i < 2; i++) await sale(s, new Date(W39_FROM.getTime() + DAY));
    await buildDigest(s.id, "2026-W39", MON_0705);
  });
  const code = async (p: Promise<unknown>) =>
    p.then(
      () => "OK",
      (e: { code?: string }) => e.code ?? String(e),
    );

  it("presser/designer FORBIDDEN; office reads without plan usage; owner sees it", async () => {
    const presser = await createUser(s.id, "presser");
    const designer = await createUser(s.id, "designer");
    expect(
      await code(
        call(router.digest.list, { limit: 5 }, { context: ctxAs(s.id, presser, "presser") }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(
        call(
          router.digest.get,
          { weekKey: "2026-W39" },
          { context: ctxAs(s.id, designer, "designer") },
        ),
      ),
    ).toBe("FORBIDDEN");
    const office = await call(
      router.digest.get,
      { weekKey: "2026-W39" },
      { context: ctxAs(s.id, s.office, "office") },
    );
    expect(office.planUsage).toBeUndefined();
    const owner = await call(
      router.digest.get,
      { weekKey: "2026-W39" },
      { context: ctxAs(s.id, s.owner, "owner") },
    );
    expect(owner.planUsage?.ordersUsed).toBeGreaterThanOrEqual(0);
    expect(owner.viewedAt).not.toBeNull();
    expect(
      await code(
        call(router.digest.settings.set, { hour: 8 }, { context: ctxAs(s.id, s.office, "office") }),
      ),
    ).toBe("FORBIDDEN");
  });

  it("another shop's week, digest or insight is NOT_FOUND; B's list is empty", async () => {
    const b = ctxAs(other.id, other.owner, "owner");
    expect(await code(call(router.digest.get, { weekKey: "2026-W39" }, { context: b }))).toBe(
      "NOT_FOUND",
    );
    expect((await call(router.digest.list, { limit: 50 }, { context: b })).items).toEqual([]);
    const row = await digestRow(s.id, "2026-W39");
    const [ins] = await withSystem((tx) =>
      tx
        .select()
        .from(digestInsights)
        .where(eq(digestInsights.digestId, row?.id ?? "")),
    );
    if (ins) {
      const ids = { digestId: ins.digestId, insightId: ins.id };
      expect(await code(call(router.digest.recordClick, ids, { context: b }))).toBe("NOT_FOUND");
      expect(await code(call(router.digest.feedback, { ...ids, vote: "up" }, { context: b }))).toBe(
        "NOT_FOUND",
      );
    }
    // Composite FK (S-26): B can't attach a row to A's digest even under its own tenant.
    await expect(
      withTenant(other.id, (tx) =>
        tx.insert(digestInsights).values({
          companyId: other.id,
          digestId: row?.id ?? "",
          detector: "D2",
          section: "action",
          rank: 1,
          score: 1,
          confidence: 1,
          fingerprint: "x",
          templateKey: "D2 action",
          action: {},
        }),
      ),
    ).rejects.toThrow();
    // RLS WITH CHECK: A's tenant can't write a row carrying B's company id.
    await expect(
      withTenant(s.id, (tx) =>
        tx.insert(digests).values({
          companyId: other.id,
          weekKey: "2026-W01",
          weekStart: "2025-12-29",
          weekEnd: "2026-01-05",
          periodFrom: new Date(),
          periodTo: new Date(),
          timezone: "UTC",
        }),
      ),
    ).rejects.toThrow();
  });

  it("feedback is idempotent and the latest vote wins; clicks keep the first time", async () => {
    const row = await digestRow(s.id, "2026-W39");
    const [ins] = await withSystem((tx) =>
      tx
        .insert(digestInsights)
        .values({
          companyId: s.id,
          digestId: row?.id ?? "",
          detector: "D2",
          section: "action",
          rank: 9,
          score: 1,
          confidence: 0.5,
          fingerprint: `test:${uniq()}`,
          templateKey: "D2 action",
          action: { kind: "see_what_changed", href: "/analytics/profit", params: {} },
        })
        .returning(),
    );
    if (!ins) throw new Error("insight");
    const owner = ctxAs(s.id, s.owner, "owner");
    const ids = { digestId: ins.digestId, insightId: ins.id };
    const a = await call(
      router.digest.feedback,
      { ...ids, vote: "down", reason: "wrong" },
      { context: owner },
    );
    const b = await call(
      router.digest.feedback,
      { ...ids, vote: "down", reason: "wrong" },
      { context: owner },
    );
    expect(b.votedAt).toBe(a.votedAt);
    const c = await call(router.digest.feedback, { ...ids, vote: "up" }, { context: owner });
    expect(c).toMatchObject({ vote: "up", reason: null });
    const k1 = await call(router.digest.recordClick, ids, { context: owner });
    const k2 = await call(router.digest.recordClick, ids, { context: owner });
    expect(k2.clickedAt).toBe(k1.clickedAt);
    // The email's signed click link records the same click and opens the in-app path.
    const handler = getLinkHandler("click");
    expect(
      await handler?.({
        companyId: s.id,
        userId: s.owner.id,
        ref: `${ids.digestId}:${ids.insightId}`,
      }),
    ).toEqual({ path: "/analytics/profit" });
    expect(
      await handler?.({
        companyId: other.id,
        userId: other.owner.id,
        ref: `${ids.digestId}:${ids.insightId}`,
      }),
    ).toBeNull();
    const market = await withSystem((tx) =>
      tx
        .insert(digestInsights)
        .values({
          ...ins,
          id: undefined,
          fingerprint: `market:${uniq()}`,
          detector: "market",
          section: "market",
        })
        .returning(),
    );
    expect(
      await code(
        call(
          router.digest.feedback,
          { digestId: ins.digestId, insightId: market[0]?.id ?? "", vote: "down" },
          { context: owner },
        ),
      ),
    ).toBe("MARKET_INSIGHT");
  });

  it("settings: defaults, partial update, recipients by permission; admin turns email off only", async () => {
    const owner = ctxAs(s.id, s.owner, "owner");
    const got = await call(router.digest.settings.get, {}, { context: owner });
    expect(got).toMatchObject({
      enabled: true,
      day: "mon",
      hour: 7,
      aiSummary: false,
      aiSummaryMode: "shadow",
    });
    expect(got.recipients.map((r) => r.userId).sort()).toEqual([s.owner.id, s.office.id].sort());
    await setEmailPreference(s.id, s.office.id, "digest", { on: true, source: "settings" });
    const off = await call(
      router.digest.settings.setRecipientEmail,
      { userId: s.office.id, on: false },
      { context: owner },
    );
    expect(off.recipients.find((r) => r.userId === s.office.id)?.emailOn).toBe(false);
    expect(
      await code(
        call(
          router.digest.settings.setRecipientEmail,
          { userId: other.owner.id, on: false },
          { context: owner },
        ),
      ),
    ).toBe("NOT_FOUND");
  });

  it("AC30: preview once a minute per caller, to the caller only; no digest → NO_DIGEST", async () => {
    await redis.del(`digest:preview:${s.id}:${s.owner.id}`);
    const owner = ctxAs(s.id, s.owner, "owner");
    const codes = [];
    for (let i = 0; i < 3; i++)
      codes.push(await code(call(router.digest.sendPreview, {}, { context: owner })));
    expect(codes).toEqual(["OK", "RATE_LIMITED", "RATE_LIMITED"]);
    expect(
      await code(
        call(router.digest.sendPreview, {}, { context: ctxAs(other.id, other.owner, "owner") }),
      ),
    ).toBe("NO_DIGEST");
  });
});

describe("retention", () => {
  it("purges digests older than the retention window and keeps recent ones", async () => {
    const s = await shop();
    await withSystem((tx) =>
      tx.insert(digests).values({
        companyId: s.id,
        weekKey: "2023-W01",
        weekStart: "2023-01-02",
        weekEnd: "2023-01-09",
        periodFrom: new Date("2023-01-02T07:00:00Z"),
        periodTo: new Date("2023-01-09T07:00:00Z"),
        timezone: "America/Phoenix",
        status: "ready",
      }),
    );
    await buildDigest(s.id, "2026-W39", MON_0705);
    await runJobInline(purgeJob, {});
    const left = await withSystem((tx) =>
      tx.select().from(digests).where(eq(digests.companyId, s.id)),
    );
    expect(left.map((d) => d.weekKey)).toEqual(["2026-W39"]);
  });
});
