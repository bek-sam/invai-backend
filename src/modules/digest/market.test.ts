import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem } from "../../db/client";
import {
  channelConnections,
  designs,
  digests,
  marketRecommendations,
  orderItems,
  orders,
} from "../../db/schema";
import { createCompany, createUser } from "../../test/fixtures";
import * as market from "../market/service";
import { buildDigest } from "./build";

/*
 * Market watch inside a real build (spec "Market watch block", AC14–AC17). The market module's
 * `listDigestMarketItems` is the real one except in the "throws" case, where a spy makes it fail.
 */

vi.mock("../market/service", async (orig) => {
  const mod = await orig<typeof import("../market/service")>();
  return { ...mod, listDigestMarketItems: vi.fn(mod.listDigestMarketItems) };
});

const uniq = () => crypto.randomUUID().slice(0, 8);
const MON_0705 = new Date("2026-09-28T14:05:00.000Z");
const IN_WEEK = new Date("2026-09-23T15:00:00.000Z");

afterEach(() => vi.mocked(market.listDigestMarketItems).mockRestore?.());

async function shopWithRec(input: {
  rule: "R1" | "R2" | "R4";
  band: "high" | "low";
  channels?: string[];
}) {
  const company = await createCompany({ name: `T-19-3 Market ${uniq()}` });
  const owner = await createUser(company.id, "owner");
  const out = await withSystem(async (tx) => {
    const [d] = await tx
      .insert(designs)
      .values({ companyId: company.id, code: `D-${uniq()}`, name: "Halloween Tee", tags: [] })
      .returning();
    const [conn] = await tx
      .insert(channelConnections)
      .values({
        companyId: company.id,
        channel: "etsy",
        name: "Etsy",
        status: "connected",
        mode: "api",
        provider: "mock",
      })
      .returning();
    const [o] = await tx
      .insert(orders)
      .values({
        companyId: company.id,
        connectionId: conn?.id ?? "",
        channel: "etsy",
        channelOrderId: `o-${uniq()}`,
        orderNo: `T-${uniq()}`,
        status: "new",
        placedAt: IN_WEEK,
        shipBy: new Date(IN_WEEK.getTime() + 5 * 86_400_000),
        subtotalCents: 2_500,
        totalCents: 2_500,
        itemCount: 1,
      })
      .returning();
    if (!o || !d) throw new Error("fixture");
    await tx.insert(orderItems).values({
      companyId: company.id,
      orderId: o.id,
      channelSku: `S-${uniq()}`,
      title: "Tee",
      state: "packed",
      shipBy: o.shipBy,
    });
    const [rec] = await tx
      .insert(marketRecommendations)
      .values({
        companyId: company.id,
        rule: input.rule,
        action:
          input.rule === "R1"
            ? "list_and_stock"
            : input.rule === "R2"
              ? "price_test_up"
              : "new_designs_in_niche",
        dedupeKey: `dk-${uniq()}`,
        createdOn: "2026-09-27",
        designId: d.id,
        params: input.channels ? { channels: input.channels } : {},
        confidence: input.band === "high" ? 0.85 : 0.3,
        band: input.band,
        mock: true,
        sources: [
          {
            source: "google_trends",
            licence: "official_api",
            asOf: "2026-09-20T00:00:00.000Z",
            fetchedAt: "2026-09-21T00:00:00.000Z",
            mock: true,
          },
        ] as never,
        evidenceSignalIds: [],
        staleAfterDays: 30,
        createdAt: new Date("2026-09-27T12:00:00.000Z"),
      })
      .returning();
    if (!rec) throw new Error("rec");
    return rec;
  });
  const ctx = {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user" as const,
    user: { id: owner.id, name: owner.name, email: owner.email },
    companyId: company.id,
    orgType: "shop" as const,
    role: "owner" as const,
    permissions: permissionsFor("owner"),
  };
  return { companyId: company.id, rec: out, ctx };
}

describe("Market watch", () => {
  it("AC14/AC17: a high R1 item shows with its recommendation, is recorded as shown in the digest", async () => {
    const s = await shopWithRec({ rule: "R1", band: "high" });
    await buildDigest(s.companyId, "2026-W39", MON_0705);
    const d = await call(router.digest.get, { weekKey: "2026-W39" }, { context: s.ctx });
    const all = [...d.actions, ...d.marketWatch].filter((i) => i.detector === "market");
    expect(all.map((i) => i.recommendation?.id)).toEqual([s.rec.id]);
    expect(all[0]?.recommendation?.mock).toBe(true);
    const [rec] = await withSystem((tx) =>
      tx.select().from(marketRecommendations).where(eq(marketRecommendations.id, s.rec.id)),
    );
    const [row] = await withSystem((tx) =>
      tx
        .select()
        .from(digests)
        .where(and(eq(digests.companyId, s.companyId), eq(digests.weekKey, "2026-W39"))),
    );
    expect(rec).toMatchObject({ shownIn: "digest", shownRef: row?.id });
    // A vote goes through the market procedure on the same record (one vote, AC17).
    await call(
      router.market.recommendations.vote,
      { id: s.rec.id, vote: "not_useful" },
      { context: s.ctx },
    );
    const again = await call(router.digest.get, { weekKey: "2026-W39" }, { context: s.ctx });
    const item = [...again.actions, ...again.marketWatch].find((i) => i.detector === "market");
    expect(item?.recommendation?.vote).toBe("not_useful");
  });

  it("AC15: an R1 with a cross-listing gap may take a top-3 slot; an R2 never does", async () => {
    const r1 = await shopWithRec({ rule: "R1", band: "high", channels: ["amazon"] });
    await buildDigest(r1.companyId, "2026-W39", MON_0705);
    const d1 = await call(router.digest.get, { weekKey: "2026-W39" }, { context: r1.ctx });
    expect(d1.actions.some((a) => a.recommendation?.id === r1.rec.id)).toBe(true);
    const r2 = await shopWithRec({ rule: "R2", band: "high" });
    await buildDigest(r2.companyId, "2026-W39", MON_0705);
    const d2 = await call(router.digest.get, { weekKey: "2026-W39" }, { context: r2.ctx });
    expect(d2.actions.some((a) => a.detector === "market")).toBe(false);
  });

  it("AC14: a low-band item never shows", async () => {
    const s = await shopWithRec({ rule: "R4", band: "low" });
    await buildDigest(s.companyId, "2026-W39", MON_0705);
    const d = await call(router.digest.get, { weekKey: "2026-W39" }, { context: s.ctx });
    expect([...d.actions, ...d.marketWatch].some((i) => i.detector === "market")).toBe(false);
  });

  it("AC16: a throwing market read leaves the block out and the digest is still ready", async () => {
    const s = await shopWithRec({ rule: "R1", band: "high" });
    vi.mocked(market.listDigestMarketItems).mockRejectedValueOnce(new Error("market down"));
    const out = await buildDigest(s.companyId, "2026-W39", MON_0705);
    expect(out.status).toBe("ready");
    const d = await call(router.digest.get, { weekKey: "2026-W39" }, { context: s.ctx });
    expect(d.marketWatch).toEqual([]);
    expect(d.actions.some((a) => a.detector === "market")).toBe(false);
  });
});
