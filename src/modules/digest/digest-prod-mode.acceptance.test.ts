/*
 * Wave 19 acceptance test: the mock visibility rule in the digest's Market watch (spec AC31, the
 * wave.md hard fence "Market watch ... inherits the mock visibility rule"). Second pass, against
 * landed backend HEAD (T-19-3 cadc338/bef6158).
 *
 * `env.isProd` is flipped to true (and `allowMocks` to false) for this file only, mirroring wave
 * 18's `market-prod-mode.acceptance.test.ts`: a real shop must see no mock-sourced item in
 * production, in Market watch or in a top-3 action slot. Field names match the landed contract
 * (0.7.0): `Digest.marketWatch`, and the `mock` flag lives on `DigestInsight.recommendation.mock`
 * (the underlying `MarketRecommendation`), not on the insight itself.
 *
 * `mondayPhoenix` returns shop-local midnight (07:00Z): the freeze below was `+5min` (before the
 * build window) and is corrected to `+7h5m` (07:05 local), same fix as `digest.acceptance.test.ts`.
 *
 * The original fixture had no order at all, so the shop's week was always `skipped_quiet`
 * (`build.ts`'s `isQuiet` gate skips Market watch entirely for a zero-order week) — the assertions
 * passed, but for the wrong reason: an empty `marketWatch` proved nothing about the prod mock
 * filter, since a totally broken filter would look identical. Fixed by adding a real sale (so the
 * week is `ready`) and a second, non-mock recommendation that must still show, so the test proves
 * the filter drops the mock item specifically rather than showing nothing because there was
 * nothing to show.
 *
 * Owner: qa-engineer. Implementers don't edit this file; disagreements go in their report.
 */
import type { Digest } from "@invai/contracts";
import { call } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../api/context";
import { router } from "../../api/router";
import { withSystem } from "../../db/client";
import {
  type Channel,
  channelConnections,
  marketRecommendations,
  orderItems,
  orders,
  profitLines,
} from "../../db/schema";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";

const DAY_MS = 86_400_000;

vi.mock("../../env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../env")>();
  return { ...mod, env: { ...mod.env, isProd: true, allowMocks: false } };
});

const uniq = () => crypto.randomUUID().slice(0, 12);

function freeze(at: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
}
afterEach(() => {
  try {
    vi.useRealTimers();
  } catch {
    // not faked in this test
  }
});

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[key];
  if (!node) throw new Error(`procedure ${path} is not on the router (T-19-3/T-19-1 router.ts)`);
  return node as AnyProcedure;
}
function rpc<T>(path: string, input: unknown, context: TenantContext): Promise<T> {
  return call(procedureAt(path), input as never, { context }) as Promise<T>;
}
const JOBS = "./jobs";
async function runDigestJob(name: string, input: unknown) {
  const { getJob, runJobInline } = await import("../../lib/queues");
  await import(JOBS);
  const job = getJob(name);
  if (!job) throw new Error(`job ${name} is not registered (T-19-3 jobs.ts)`);
  return runJobInline(job, input);
}

async function shop(name: string, orgType: "shop" = "shop") {
  const company = await createCompany({ name: `${name} ${uniq()}`, type: orgType });
  const owner = await createUser(company.id, "owner", { email: `owner-${uniq()}@test.local` });
  const [etsy] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId: company.id,
        channel: "etsy" as Channel,
        name: "etsy",
        status: "connected",
        mode: "api",
        provider: "mock",
        connectedAt: new Date(),
      })
      .returning(),
  );
  if (!etsy) throw new Error("connection insert failed");
  return {
    id: company.id,
    owner: tenantContext(company.id, owner.id, "owner") as TenantContext,
    etsy,
  };
}

async function recommendation(companyId: string, mock: boolean, createdAt: Date) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(marketRecommendations)
      .values({
        companyId,
        rule: "R1",
        action: "list_and_stock",
        dedupeKey: `dk-${uniq()}`,
        createdOn: createdAt.toISOString().slice(0, 10),
        confidence: 0.8,
        band: "high",
        mock,
        sources: [],
        evidenceSignalIds: [],
        staleAfterDays: 30,
        createdAt,
        updatedAt: createdAt,
      })
      .returning(),
  );
  if (!row) throw new Error("recommendation insert failed");
  return row;
}

/** A minimal sale inside the target week: see this file's header note on why one is needed. */
async function saleAt(companyId: string, connectionId: string, channel: Channel, placedAt: Date) {
  return withSystem(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        companyId,
        connectionId,
        channel,
        channelOrderId: `ord-${uniq()}`,
        orderNo: `T-${uniq()}`,
        status: "new",
        placedAt,
        shipBy: new Date(placedAt.getTime() + 2 * DAY_MS),
        subtotalCents: 2500,
        totalCents: 2500,
        itemCount: 1,
      })
      .returning();
    if (!order) throw new Error("order insert failed");
    const [item] = await tx
      .insert(orderItems)
      .values({
        companyId,
        orderId: order.id,
        channelSku: `SKU-${uniq()}`,
        title: "Fixture tee",
        state: "packed",
        shipBy: order.shipBy,
      })
      .returning();
    if (!item) throw new Error("order item insert failed");
    await tx.insert(profitLines).values({
      companyId,
      orderId: order.id,
      orderItemId: item.id,
      channel,
      revenueCents: 2500,
      netCents: 1200,
      marginPct: 1200 / 2500,
      placedAt,
    });
  });
}

describe("AC31: a real shop in production never shows a mock-sourced Market watch item", () => {
  it("Market watch is absent (no other qualifying item) and no top-3 action comes from the mock item", async () => {
    const s = await shop("Prod Real Tees");
    const monday = new Date("2026-09-28T07:00:00.000Z"); // Monday 00:00 America/Phoenix (no DST)
    const createdAt = new Date(monday.getTime() - 2 * DAY_MS); // inside the 7-day market window
    await recommendation(s.id, true, createdAt); // the only source in this test: never shown in prod
    await saleAt(s.id, s.etsy.id, "etsy", new Date(monday.getTime() - 3 * DAY_MS));
    freeze(new Date(monday.getTime() + 7 * 60 * 60_000 + 5 * 60_000).toISOString());
    await runDigestJob("digest.sweep", {});
    const digest = await rpc<Digest>("digest.get", { weekKey: "2026-W39" }, s.owner);
    expect(digest.status).toBe("ready");
    expect(digest.marketWatch).toHaveLength(0);
    expect(digest.actions.every((a) => !a.recommendation?.mock)).toBe(true);
  });
});
