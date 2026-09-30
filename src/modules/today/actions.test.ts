import { type Role, TodayActions } from "@invai/contracts";
import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import { todayActionClicks, todayActionSets, todayActions } from "../../db/schema";
import { runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { profitBridge, unitEconomics } from "../analytics/finance-service";
import { buildScenario, localPeriod } from "../analytics/finance-testkit";
import { detect } from "../digest/detectors";
import { shopInfo } from "../digest/service";
import { computeSnapshot } from "../digest/snapshot";
import {
  type BuildTodayResult,
  buildable,
  buildTodayActions,
  getTodayActions,
  recordActionClick,
} from "./actions";
import { buildTodayActionsJob, purgeTodayActions, shopsMissingToday } from "./jobs";

/*
 * T-A9: Today's action panel (AC-E2, AC-E4, AC-E5, job run-twice and purge) and the digest legs
 * of AC-E1f (D2 names the bridge's top mover) and AC-G1 (the snapshot's net is computeNet's).
 * The scenario (finance-testkit) is the week 2026-08-10..17 with 37 orders; the Today set for
 * 2026-08-17 has exactly that week as its window.
 */

const DATE = "2026-08-17";

function routerContext(
  companyId: string,
  user: { id: string; name: string; email: string },
  role: Role,
  orgType: "shop" | "vendor" = "shop",
) {
  return {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user" as const,
    user,
    companyId,
    orgType,
    role,
    permissions: permissionsFor(role),
  };
}

const countRows = (companyId: string) =>
  withSystem(async (tx) => {
    const n = async (table: string) =>
      Number(
        (
          await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from ${sql.raw(table)} where company_id = ${companyId}`,
          )
        ).rows[0]?.n ?? 0,
      );
    return {
      sets: await n("today_action_sets"),
      actions: await n("today_actions"),
      clicks: await n("today_action_clicks"),
    };
  });

describe("Today actions (T-A9)", () => {
  let a: string;
  let b: string;
  let owner: { id: string; name: string; email: string };
  let office: { id: string; name: string; email: string };

  beforeAll(async () => {
    a = (await createCompany()).id;
    b = (await createCompany()).id;
    owner = await createUser(a, "owner");
    office = await createUser(a, "office");
    await buildScenario(a);
  });

  it("AC-G1 digest leg: the snapshot's net for the week equals analytics.unitEconomics (order) to the cent", async () => {
    await withTenant(a, async (tx) => {
      const period = await localPeriod(a, "2026-08-10", DATE);
      const { timezone } = await shopInfo(tx, { companyId: a });
      const snap = await computeSnapshot(
        tx,
        { companyId: a },
        {
          weekKey: "2026-W33",
          weekStart: "2026-08-10",
          weekEnd: DATE,
          periodFrom: new Date(period.from),
          periodTo: new Date(period.to),
          timezone,
        },
        new Date(`${DATE}T15:00:00Z`),
      );
      const ue = await unitEconomics(tx, { companyId: a }, { period, dimension: "order" });
      expect(snap.current.net).toBe(ue.totals.cm3);
      expect(snap.current.net).not.toBe(0);

      // AC-E1f: D2 names the mover analytics.profitBridge ranks first for the same period.
      const bridge = await profitBridge(tx, { companyId: a }, { period });
      const top = bridge.topMovers[0];
      expect(snap.trackE?.bridgeTopMover?.key).toBe(top?.key);
      const d2 = detect(snap).find((c) => c.detector === "D2");
      expect(d2).toBeDefined();
      expect(d2?.action.params.designName).toBe(top?.label);
      expect(d2?.facts.find((f) => f.id === "d2.topMover")?.value).toBe(top?.label);
    });
  });

  it("before the build: generatedAt null, no actions, not steady, and the read asks for the build", async () => {
    const asked: string[] = [];
    const out = await withTenant(a, (tx) =>
      getTodayActions(
        tx,
        { companyId: a, userId: owner.id },
        { date: "2026-09-01" },
        { requestBuild: (d) => asked.push(d) },
      ),
    );
    expect(out).toMatchObject({
      date: "2026-09-01",
      windowStart: "2026-08-25",
      windowEnd: "2026-08-31",
      actions: [],
      steady: false,
      generatedAt: null,
    });
    expect(asked).toEqual(["2026-09-01"]);
    // A future day or one past retention is never built.
    expect(buildable("2026-10-02", "2026-10-01")).toBe(false);
    expect(buildable("2026-07-01", "2026-10-01")).toBe(false);
    expect(buildable("2026-10-01", "2026-10-01")).toBe(true);
  });

  it("AC-E2 + job: the build job run twice leaves one set of ≤ 5 ranked actions with integer cents", async () => {
    const first = (await runJobInline(buildTodayActionsJob, {
      companyId: a,
      date: DATE,
    })) as BuildTodayResult;
    expect(first.status).toBe("built");
    const before = await countRows(a);
    const read1 = await withTenant(a, (tx) =>
      getTodayActions(tx, { companyId: a, userId: owner.id }, { date: DATE }),
    );
    const second = (await runJobInline(buildTodayActionsJob, {
      companyId: a,
      date: DATE,
    })) as BuildTodayResult;
    expect(second.status).toBe("exists");
    expect(await countRows(a)).toEqual(before);
    const read2 = await withTenant(a, (tx) =>
      getTodayActions(tx, { companyId: a, userId: owner.id }, { date: DATE }),
    );
    expect(read2).toEqual(read1);

    expect(TodayActions.parse(read1)).toEqual(read1);
    expect(read1.generatedAt).not.toBeNull();
    expect(read1.windowStart).toBe("2026-08-10");
    expect(read1.windowEnd).toBe("2026-08-16");
    expect(read1.actions.length).toBeGreaterThan(0);
    expect(read1.actions.length).toBeLessThanOrEqual(5);
    expect(read1.steady).toBe(false);
    expect(read1.actions.map((x) => x.rank)).toEqual(read1.actions.map((_, i) => i + 1));
    for (const x of read1.actions) {
      if (x.impactCents !== null) expect(Number.isInteger(x.impactCents)).toBe(true);
      expect(x.clickedAt).toBeNull();
    }
    // The same wording kinds as the digest: D2 names the bridge's top mover here too.
    expect(read1.actions.some((x) => x.kind === "see_what_changed")).toBe(true);
    expect(before.sets).toBe(1);
    expect(before.actions).toBe(read1.actions.length);
  });

  it("force rebuilds in place: delete + insert in one transaction, still one set", async () => {
    const before = await countRows(a);
    const out = await buildTodayActions(a, DATE, { force: true });
    expect(out.status).toBe("built");
    const after = await countRows(a);
    expect(after.sets).toBe(before.sets);
    expect(after.actions).toBe(before.actions);
  });

  it("a healthy day (no detector fires) is built and steady", async () => {
    const quiet = (await createCompany()).id;
    await buildTodayActions(quiet, DATE);
    const out = await withTenant(quiet, (tx) =>
      getTodayActions(tx, { companyId: quiet, userId: null }, { date: DATE }),
    );
    expect(out.actions).toEqual([]);
    expect(out.steady).toBe(true);
    expect(out.generatedAt).not.toBeNull();
  });

  it("recordActionClick is idempotent per person: two calls, one row, the same clickedAt", async () => {
    const set = await withTenant(a, (tx) =>
      getTodayActions(tx, { companyId: a, userId: owner.id }, { date: DATE }),
    );
    const key = set.actions[0]?.key as string;
    const c1 = await withTenant(a, (tx) =>
      recordActionClick(tx, { companyId: a, userId: owner.id }, { date: DATE, key }),
    );
    await new Promise((r) => setTimeout(r, 10));
    const c2 = await withTenant(a, (tx) =>
      recordActionClick(tx, { companyId: a, userId: owner.id }, { date: DATE, key }),
    );
    expect(c2).toEqual(c1);
    const rows = await withTenant(a, (tx) =>
      tx
        .select()
        .from(todayActionClicks)
        .where(and(eq(todayActionClicks.companyId, a), eq(todayActionClicks.key, key))),
    );
    expect(rows).toHaveLength(1);
    // The owner sees their click; another member doesn't.
    const mine = await withTenant(a, (tx) =>
      getTodayActions(tx, { companyId: a, userId: owner.id }, { date: DATE }),
    );
    expect(mine.actions[0]?.clickedAt).toBe(c1.clickedAt);
    const theirs = await withTenant(a, (tx) =>
      getTodayActions(tx, { companyId: a, userId: office.id }, { date: DATE }),
    );
    expect(theirs.actions[0]?.clickedAt).toBeNull();
  });

  it("unknown key → ACTION_NOT_FOUND", async () => {
    await expect(
      withTenant(a, (tx) =>
        recordActionClick(tx, { companyId: a, userId: owner.id }, { date: DATE, key: "D99:nope" }),
      ),
    ).rejects.toMatchObject({ code: "ACTION_NOT_FOUND", status: 404 });
  });

  it("AC-E4: company B never sees A's actions or clicks, and can't click A's key", async () => {
    const aSet = await withTenant(a, (tx) =>
      getTodayActions(tx, { companyId: a, userId: owner.id }, { date: DATE }),
    );
    const key = aSet.actions[0]?.key as string;
    const bUser = await createUser(b, "owner");
    const bRead = await withTenant(b, (tx) =>
      getTodayActions(tx, { companyId: b, userId: bUser.id }, { date: DATE }),
    );
    expect(bRead.actions).toEqual([]);
    expect(bRead.generatedAt).toBeNull();
    await expect(
      withTenant(b, (tx) =>
        recordActionClick(tx, { companyId: b, userId: bUser.id }, { date: DATE, key }),
      ),
    ).rejects.toMatchObject({ code: "ACTION_NOT_FOUND" });
    // Raw reads under B's tenant return none of A's rows (RLS).
    const leaked = await withTenant(b, (tx) =>
      tx.select().from(todayActions).where(eq(todayActions.companyId, a)),
    );
    expect(leaked).toEqual([]);
    // Writing a row for A from B's tenant fails the RLS check.
    await expect(
      withTenant(b, (tx) =>
        tx.insert(todayActionSets).values({
          companyId: a,
          date: "2026-08-01",
          windowStart: "2026-07-25",
          windowEnd: "2026-07-31",
        }),
      ),
    ).rejects.toThrow();
    // A click row of B can't point at A's action: the composite FK refuses it even without RLS.
    const [aAction] = await withTenant(a, (tx) =>
      tx.select({ id: todayActions.id }).from(todayActions).where(eq(todayActions.key, key)),
    );
    await expect(
      withSystem((tx) =>
        tx.insert(todayActionClicks).values({
          companyId: b,
          actionId: aAction?.id as string,
          date: DATE,
          key,
          userId: bUser.id,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("AC-E5: designer, presser, packer, receiver and vendor get FORBIDDEN; owner and office read", async () => {
    for (const role of ["designer", "presser", "packer", "receiver"] as const) {
      const u = await createUser(a, role);
      const ctx = routerContext(a, u, role);
      await expect(
        call(router.today.actions, { date: DATE }, { context: ctx }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        call(router.today.recordActionClick, { date: DATE, key: "D2:net:up" }, { context: ctx }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const vendorCo = (await createCompany({ type: "vendor" })).id;
    const v = await createUser(vendorCo, "vendor");
    const vctx = routerContext(vendorCo, v, "vendor", "vendor");
    await expect(call(router.today.actions, {}, { context: vctx })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      call(router.today.recordActionClick, { date: DATE, key: "x" }, { context: vctx }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    for (const [role, u] of [
      ["owner", owner],
      ["office", office],
    ] as const) {
      const out = await call(
        router.today.actions,
        { date: DATE },
        {
          context: routerContext(a, u, role),
        },
      );
      expect(out.generatedAt).not.toBeNull();
      const key = out.actions[0]?.key as string;
      const c1 = await call(
        router.today.recordActionClick,
        { date: DATE, key },
        {
          context: routerContext(a, u, role),
        },
      );
      const c2 = await call(
        router.today.recordActionClick,
        { date: DATE, key },
        {
          context: routerContext(a, u, role),
        },
      );
      expect(c2.clickedAt).toBe(c1.clickedAt);
    }
    await expect(
      call(
        router.today.recordActionClick,
        { date: DATE, key: "D99:nope" },
        {
          context: routerContext(a, owner, "owner"),
        },
      ),
    ).rejects.toMatchObject({ code: "ACTION_NOT_FOUND" });
  });

  it("sweep: a shop with no set for its local day is listed until it is built, once", async () => {
    const c = (await createCompany()).id;
    const at = new Date("2026-09-30T18:00:00Z");
    const localDay = "2026-09-30";
    const due = async () =>
      (await shopsMissingToday(at, null, 100_000)).filter((s) => s.companyId === c);
    expect(await due()).toEqual([{ companyId: c, date: localDay }]);
    for (const s of await due()) {
      await runJobInline(buildTodayActionsJob, s);
      await runJobInline(buildTodayActionsJob, s);
    }
    expect(await due()).toEqual([]);
    expect((await countRows(c)).sets).toBe(1);
  });

  it("purge: sets older than 90 days go with their actions and clicks; recent ones stay", async () => {
    const p = (await createCompany()).id;
    const u = await createUser(p, "owner");
    const at = new Date("2026-09-30T12:00:00Z");
    await withTenant(p, async (tx) => {
      for (const date of ["2026-06-01", "2026-07-15"]) {
        const [set] = await tx
          .insert(todayActionSets)
          .values({ companyId: p, date, windowStart: date, windowEnd: date })
          .returning({ id: todayActionSets.id });
        const [act] = await tx
          .insert(todayActions)
          .values({
            companyId: p,
            setId: set?.id as string,
            date,
            key: "D10:losing",
            rank: 1,
            detector: "D10",
            kind: "review_losing_orders",
            href: "/analytics/profit?view=losing&days=7",
          })
          .returning({ id: todayActions.id });
        await tx.insert(todayActionClicks).values({
          companyId: p,
          actionId: act?.id as string,
          date,
          key: "D10:losing",
          userId: u.id,
        });
      }
    });
    const first = await purgeTodayActions(at);
    expect(first.deleted).toBeGreaterThanOrEqual(1);
    expect(await countRows(p)).toEqual({ sets: 1, actions: 1, clicks: 1 });
    const kept = await withTenant(p, (tx) =>
      tx.select({ date: todayActionSets.date }).from(todayActionSets),
    );
    expect(kept).toEqual([{ date: "2026-07-15" }]);
    // Run twice: nothing more to delete for this shop.
    await purgeTodayActions(at);
    expect(await countRows(p)).toEqual({ sets: 1, actions: 1, clicks: 1 });
  });

  it("no buyer data rides in stored params", async () => {
    const rows = await withTenant(a, (tx) =>
      tx.select({ params: todayActions.params }).from(todayActions),
    );
    for (const r of rows)
      for (const k of Object.keys(r.params))
        expect(["buyer", "email", "address", "name", "phone", "note"]).not.toContain(k);
    expect(tenantContext(a, owner.id, "owner").permissions.has("finance.read")).toBe(true);
  });
});
