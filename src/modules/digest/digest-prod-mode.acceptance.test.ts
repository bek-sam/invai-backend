/*
 * Wave 19 acceptance test: the mock visibility rule in the digest's Market watch (spec AC31, the
 * wave.md hard fence "Market watch ... inherits the mock visibility rule"). First pass, expected
 * red until T-19-3 lands.
 *
 * `env.isProd` is flipped to true (and `allowMocks` to false) for this file only, mirroring wave
 * 18's `market-prod-mode.acceptance.test.ts`: a real shop must see no mock-sourced item in
 * production, in Market watch or in a top-3 action slot. Field names match the landed contract
 * (0.7.0): `Digest.marketWatch`, and the `mock` flag lives on `DigestInsight.recommendation.mock`
 * (the underlying `MarketRecommendation`), not on the insight itself.
 *
 * Owner: qa-engineer. Implementers don't edit this file; disagreements go in their report.
 */
import type { Digest } from "@invai/contracts";
import { call } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../api/context";
import { router } from "../../api/router";
import { withSystem } from "../../db/client";
import { type Channel, channelConnections, marketRecommendations } from "../../db/schema";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";

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
  return { id: company.id, owner: tenantContext(company.id, owner.id, "owner") as TenantContext };
}

async function mockRecommendation(companyId: string) {
  const now = new Date();
  const [row] = await withSystem((tx) =>
    tx
      .insert(marketRecommendations)
      .values({
        companyId,
        rule: "R1",
        action: "list_and_stock",
        dedupeKey: `dk-${uniq()}`,
        createdOn: now.toISOString().slice(0, 10),
        confidence: 0.8,
        band: "high",
        mock: true, // the only source in this test: a real shop in prod must never show it
        sources: [],
        evidenceSignalIds: [],
        staleAfterDays: 30,
      })
      .returning(),
  );
  if (!row) throw new Error("recommendation insert failed");
  return row;
}

describe("AC31: a real shop in production never shows a mock-sourced Market watch item", () => {
  it("Market watch is absent (no other qualifying item) and no top-3 action comes from the mock item", async () => {
    const s = await shop("Prod Real Tees");
    const monday = new Date("2026-09-28T07:00:00.000Z"); // Monday 00:00 America/Phoenix (no DST)
    await mockRecommendation(s.id);
    freeze(new Date(monday.getTime() + 5 * 60_000).toISOString());
    await runDigestJob("digest.sweep", {});
    const digest = await rpc<Digest>("digest.get", { weekKey: "2026-W39" }, s.owner);
    expect(digest.marketWatch).toHaveLength(0);
    expect(digest.actions.every((a) => !a.recommendation?.mock)).toBe(true);
  });
});
