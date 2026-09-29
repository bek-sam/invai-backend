import { describe, expect, it } from "vitest";
import { glanceOf } from "./build";
import { DIGEST_CONFIG as C } from "./config";
import { d4Ads, d6Fulfillment, d7Stock, detect } from "./detectors";
import { changeFact, fact } from "./facts";
import { isPromotable, marketCandidates } from "./market-watch";
import { rank } from "./rank";
import {
  actionPart,
  expand,
  type RenderInsight,
  type RenderModel,
  renderEmail,
  renderParts,
  TEMPLATES,
} from "./render";
import type { Candidate, History, Snapshot } from "./types";
import { addDays, isoWeekKey, lastCompleteWeek, mondayOfWeekKey } from "./week";

/* Pure digest logic: week keys, detectors, ranking, Market watch mapping and the templates. */

const NO_HISTORY: History = { votedDownLastWeek: new Set(), weeksShownWithoutAction: new Map() };

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  const totals = {
    orders: 12,
    units: 12,
    revenue: 30_000,
    net: 9_000,
    marginPct: 30,
    adsCost: 0,
    avgOrderValue: 2_500,
  };
  const zero = {
    channelFees: 0,
    blankCost: 0,
    transferCost: 0,
    labelCost: 0,
    packagingCost: 0,
    laborCost: 0,
    adsCost: 0,
    refunds: 0,
  };
  return {
    weekKey: "2026-W39",
    weekStart: "2026-09-21",
    weekEnd: "2026-09-28",
    periodFrom: "2026-09-21T07:00:00.000Z",
    periodTo: "2026-09-28T07:00:00.000Z",
    timezone: "America/Phoenix",
    asOf: "2026-09-28T14:05:00.000Z",
    current: totals,
    previous: { ...totals },
    trailingNet: [9_000, 8_800, 9_100, 9_050],
    trailingRevenue: [30_000, 29_000, 31_000, 30_500],
    costLines: { current: zero, previous: zero },
    byChannel: [
      {
        channel: "etsy",
        revenue: 30_000,
        previousRevenue: 30_000,
        net: 9_000,
        previousNet: 9_000,
        orders: 12,
      },
    ],
    incompleteOrders: 0,
    ads: [],
    designs: { rising: [], lowMargin: [], crossListingGaps: [], top: [] },
    fulfillment: {
      channels: [],
      overdueNow: 0,
      shipped: 0,
      onTimeRate: null,
      previousOnTimeRate: null,
      bestTrailingOnTimeRate: null,
      reprints: 0,
      previousReprints: 0,
      reprintCostCents: 0,
      topReprintReason: null,
      itemsPlaced: 12,
    },
    lowStock: [],
    unhealthyChannels: [],
    ...over,
  };
}

function cand(over: Partial<Candidate> & Pick<Candidate, "detector" | "fingerprint">): Candidate {
  return {
    section: "action",
    impactCents: 10_000,
    confidence: 0.8,
    templateKey: `${over.detector} action`,
    action: { kind: "see_what_changed", href: "/analytics/profit", params: {} },
    facts: [],
    ...over,
  };
}

describe("ISO weeks", () => {
  it("keys and Mondays agree, including week 1 and week 53", () => {
    expect(isoWeekKey("2026-09-21")).toBe("2026-W39");
    expect(isoWeekKey("2026-09-27")).toBe("2026-W39");
    expect(mondayOfWeekKey("2026-W39")).toBe("2026-09-21");
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(mondayOfWeekKey("2026-W53")).toBe("2026-12-28");
    expect(isoWeekKey("2021-01-04")).toBe("2021-W01");
    expect(() => mondayOfWeekKey("2026-W54")).toThrow();
    expect(lastCompleteWeek("2026-09-28")).toEqual({
      weekKey: "2026-W39",
      weekStart: "2026-09-21",
      weekEnd: "2026-09-28",
    });
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
  });
});

describe("detectors", () => {
  it("AC8: a small steady shop fires nothing (no D4 without ad spend) and is steady", () => {
    const s = snapshot();
    expect(detect(s)).toEqual([]);
    expect(rank(detect(s), NO_HISTORY).steady).toBe(true);
  });

  it("D2 needs ≥ 15% and ≥ $100 vs last week and vs the trailing median", () => {
    const up = snapshot({ current: { ...snapshot().current, net: 12_000 } });
    // +33% and +$30: over 15% but under $100 → nothing.
    expect(detect(up).filter((c) => c.detector === "D2")).toEqual([]);
    const big = snapshot({
      current: { ...snapshot().current, net: 30_000, revenue: 60_000 },
      byChannel: [
        {
          channel: "etsy",
          revenue: 60_000,
          previousRevenue: 30_000,
          net: 30_000,
          previousNet: 9_000,
          orders: 20,
        },
      ],
    });
    const d2 = detect(big).filter((c) => c.detector === "D2");
    expect(d2).toHaveLength(1);
    expect(d2[0]?.action.kind).toBe("see_what_changed");
    expect(d2[0]?.facts.find((f) => f.id === "d2.net.topChannel")?.value).toBe("etsy");
  });

  it("D3 needs ≥ 20 orders and a ≥ 3-point drop, and names the cost line that moved most", () => {
    const zero = snapshot().costLines.current;
    const s = snapshot({
      current: { ...snapshot().current, orders: 25, marginPct: 20 },
      previous: { ...snapshot().previous, orders: 25, marginPct: 30 },
      costLines: {
        current: { ...zero, blankCost: 6_000 },
        previous: { ...zero, blankCost: 3_000 },
      },
    });
    const d3 = detect(s).filter((c) => c.detector === "D3");
    expect(d3[0]?.action).toMatchObject({
      kind: "review_costs",
      params: { costLine: "blankCost" },
    });
    const few = snapshot({ ...s, current: { ...s.current, orders: 12 } });
    expect(detect(few).filter((c) => c.detector === "D3")).toEqual([]);
  });

  it("D4: low ROAS or negative net after ads fires per channel; tiny spend is guarded", () => {
    const base = {
      channel: "amazon" as const,
      spend: 5_000,
      previousSpend: 4_000,
      revenue: 6_000,
      previousRevenue: 8_000,
      roas: 1.2,
      netAfterAds: -1_000,
    };
    expect(d4Ads(snapshot({ ads: [base] }))).toHaveLength(1);
    expect(d4Ads(snapshot({ ads: [{ ...base, spend: C.d4.minSpendCents - 1 }] }))).toEqual([]);
  });

  it("most orders without final fees: money-based detectors stay silent", () => {
    const ads = [
      {
        channel: "etsy" as const,
        spend: 5_000,
        previousSpend: 4_000,
        revenue: 0,
        previousRevenue: 8_000,
        roas: 0,
        netAfterAds: -5_000,
      },
    ];
    expect(detect(snapshot({ ads })).some((c) => c.detector === "D4")).toBe(true);
    const unsure = snapshot({
      ads,
      incompleteOrders: 75,
      current: { ...snapshot().current, orders: 0 },
    });
    expect(detect(unsure).some((c) => c.detector === "D4")).toBe(false);
  });

  it("D6: overdue orders give one action with the count; a reprint spike another", () => {
    const s = snapshot({
      fulfillment: {
        ...snapshot().fulfillment,
        overdueNow: 4,
        channels: [
          {
            channel: "etsy",
            shipped: 20,
            onTimeRate: 0.8,
            previousOnTimeRate: 0.97,
            previousShipped: 20,
            overdueNow: 4,
          },
        ],
        reprints: 5,
        previousReprints: 1,
        reprintCostCents: 2_000,
        topReprintReason: "misprint",
      },
    });
    const d6 = d6Fulfillment(s);
    expect(d6.map((c) => c.action.kind)).toEqual(["ship_overdue", "see_reprints"]);
    expect(d6[0]?.action).toMatchObject({
      href: "/orders?view=overdue&channel=etsy",
      params: { n: 4, channel: "etsy" },
    });
    expect(d6[0]?.facts.find((f) => f.id === "d6.overdueNow")?.value).toBe(4);
    expect(d6[0]?.facts.find((f) => f.id === "d6.etsy.onTimeRate")?.value).toBe(0.8);
  });

  it("D7 prefers blanks linked to top designs and falls back at lower confidence", () => {
    const linked = {
      blankVariantId: "00000000-0000-4000-8000-000000000001",
      name: "Gildan G640 Black L",
      available: 2,
      reorderPoint: 24,
      forDesign: { designId: "00000000-0000-4000-8000-000000000002", name: "Cactus" },
      designUnits: 6,
    };
    const loose = {
      ...linked,
      blankVariantId: "00000000-0000-4000-8000-000000000003",
      forDesign: null,
    };
    const both = d7Stock(snapshot({ lowStock: [linked, loose] }));
    expect(both.map((c) => c.fingerprint)).toEqual([`D7:${linked.blankVariantId}`]);
    expect(both[0]?.action.params.blankName).toBe("Gildan G640 Black L");
    const only = d7Stock(snapshot({ lowStock: [loose] }));
    expect(only[0]?.confidence).toBeLessThan(both[0]?.confidence ?? 0);
  });

  it("D1: one row per unhealthy connection, pinned first even with a lower score", () => {
    const s = snapshot({
      unhealthyChannels: [
        {
          connectionId: "00000000-0000-4000-8000-00000000000a",
          channel: "amazon",
          status: "error",
        },
        { connectionId: "00000000-0000-4000-8000-00000000000b", channel: "etsy", status: "error" },
      ],
    });
    const r = rank(
      [...detect(s), cand({ detector: "D6", fingerprint: "D6:overdue", impactCents: 10_000_000 })],
      NO_HISTORY,
    );
    expect(r.actions.map((a) => a.detector)).toEqual(["D1", "D1", "D6"]);
  });
});

describe("ranking", () => {
  const many = [
    cand({ detector: "D2", fingerprint: "a", impactCents: 50_000 }),
    cand({ detector: "D3", fingerprint: "b", impactCents: 40_000 }),
    cand({ detector: "D5", fingerprint: "c", impactCents: 30_000 }),
    cand({ detector: "D6", fingerprint: "d", impactCents: 20_000 }),
    cand({ detector: "D8", fingerprint: "w1", section: "win", impactCents: 5_000 }),
    cand({ detector: "D8", fingerprint: "w2", section: "win", impactCents: 9_000 }),
  ];

  it("keeps at most 3 actions and 1 win, ranked by impact × confidence × severity", () => {
    const r = rank(many, NO_HISTORY);
    expect(r.actions).toHaveLength(3);
    expect(r.actions.map((a) => a.rank)).toEqual([1, 2, 3]);
    expect(r.win?.fingerprint).toBe("w2");
    for (const a of r.actions) expect(a.score).toBeGreaterThan(0);
  });

  it("AC12: voted down last week → demoted below an equal score; 3 weeks unclicked → out", () => {
    const equal = [
      cand({ detector: "D2", fingerprint: "x", impactCents: 10_000 }),
      cand({ detector: "D2", fingerprint: "y", impactCents: 10_000 }),
    ];
    const r = rank(equal, { ...NO_HISTORY, votedDownLastWeek: new Set(["x"]) });
    expect(r.actions.map((a) => a.fingerprint)).toEqual(["y", "x"]);
    const tired = rank(equal, {
      ...NO_HISTORY,
      weeksShownWithoutAction: new Map([["y", C.ranking.maxWeeksShownWithoutAction]]),
    });
    expect(tired.actions.map((a) => a.fingerprint)).toEqual(["x"]);
  });

  it("AC15: a promotable market item may take one top-3 slot; others stay in Market watch", () => {
    const market = (fp: string, promotable: boolean, confidence = 0.9): Candidate => ({
      ...cand({ detector: "market", fingerprint: fp, section: "market", impactCents: null }),
      confidence,
      promotable,
    });
    const r = rank(
      [
        market("m1", true),
        market("m2", true),
        market("m3", false),
        cand({ detector: "D6", fingerprint: "d" }),
      ],
      NO_HISTORY,
    );
    const inActions = r.actions.filter((a) => a.detector === "market").map((a) => a.fingerprint);
    expect(inActions.length).toBeLessThanOrEqual(1);
    expect(inActions).not.toContain("m3");
    expect(r.marketWatch.length).toBeLessThanOrEqual(2);
    for (const m of r.marketWatch) expect(inActions).not.toContain(m.fingerprint);
  });
});

const marketRec = (over: Record<string, unknown> = {}) =>
  ({
    id: "00000000-0000-4000-8000-0000000000aa",
    rule: "R1",
    action: "list_and_stock",
    target: { designId: null, designName: "Cactus", niche: null, channel: null },
    params: { channels: ["amazon"] },
    confidence: 0.8,
    band: "high",
    mock: true,
    sources: [
      {
        source: "google_trends",
        licence: "official_api",
        asOf: "2026-09-20T00:00:00.000Z",
        fetchedAt: "2026-09-21T00:00:00.000Z",
        mock: true,
      },
    ],
    evidenceSignalIds: [],
    stale: false,
    shownIn: null,
    shownAt: null,
    vote: null,
    votedAt: null,
    adoptedAt: null,
    outcome: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    ...over,
  }) as never;

describe("Market watch mapping", () => {
  const rec = marketRec;

  it("AC31: mock items are dropped when mocks may not show; low band and stale never show", () => {
    expect(marketCandidates([rec()], { mockAllowed: false })).toEqual([]);
    expect(marketCandidates([rec({ band: "low" })], { mockAllowed: true })).toEqual([]);
    expect(marketCandidates([rec({ stale: true })], { mockAllowed: true })).toEqual([]);
    const [c] = marketCandidates([rec()], { mockAllowed: true });
    expect(c?.facts.find((f) => f.id.endsWith(".source"))?.value).toBe("google_trends");
    expect(c?.facts.find((f) => f.id.endsWith(".asOf"))?.value).toBe("2026-09-20");
  });

  it("AC15: R1 with a gap or low blank and R3 are promotable; R2 and R4 never", () => {
    expect(isPromotable(rec())).toBe(true);
    expect(isPromotable(rec({ params: {} }))).toBe(false);
    expect(isPromotable(rec({ params: { blankBelowReorderPoint: true } }))).toBe(true);
    expect(isPromotable(rec({ rule: "R3" }))).toBe(true);
    expect(isPromotable(rec({ rule: "R2", params: { channels: ["amazon"] } }))).toBe(false);
    expect(isPromotable(rec({ rule: "R4" }))).toBe(false);
  });
});

describe("R1 channel-list fallback (T-19-3 round 2)", () => {
  const insight = (recOver: Record<string, unknown> = {}): RenderInsight => ({
    id: "i-r1",
    detector: "market",
    action: { kind: "market", params: {}, href: "/market/r1" },
    facts: [],
    recommendation: marketRec(recOver),
  });

  it("with several channels, lists each one, in en and es", () => {
    const i = insight({ params: { channels: ["amazon", "etsy"], blankName: "3XL blank" } });
    for (const lang of ["en", "es"] as const) {
      const part = actionPart(i, lang);
      expect(part.key).toBe("R1 action");
      expect(part.vars.channels).toBe("Amazon, Etsy");
      const text = expand(part, lang);
      expect(text).not.toMatch(/ on {2}| en {2}/);
    }
  });

  it("with exactly one channel, lists that channel, in en and es", () => {
    const i = insight({ params: { channels: ["etsy"], blankName: "3XL blank" } });
    for (const lang of ["en", "es"] as const) {
      const part = actionPart(i, lang);
      expect(part.vars.channels).toBe("Etsy");
      expect(expand(part, lang)).not.toMatch(/ on {2}| en {2}/);
    }
  });

  it("with no channel list and no target/params channel, falls back to plain wording, never an empty placeholder, in en and es", () => {
    const i = insight({
      target: { designId: null, designName: "Cactus", niche: null, channel: null },
      params: { blankName: "3XL blank" },
    });
    const en = actionPart(i, "en");
    expect(en.vars.channels).toBe("your connected channels");
    expect(expand(en, "en")).toBe(
      "List Cactus on your connected channels and stock 3XL blank before .",
    );
    const es = actionPart(i, "es");
    expect(es.vars.channels).toBe("tus canales conectados");
    expect(expand(es, "es")).toBe(
      "Publica Cactus en tus canales conectados y surte 3XL blank antes de .",
    );
    for (const lang of ["en", "es"] as const) {
      expect(expand(actionPart(i, lang), lang)).not.toMatch(/ on {2}| en {2}/);
    }
  });
});

describe("templates (AC13, AC18, P1)", () => {
  const net = fact("glance.net", "cents", 123_456);
  const model: RenderModel = {
    shopName: "Desert Fixture Tees",
    weekStart: "2026-09-21",
    weekEnd: "2026-09-28",
    glance: [
      {
        metric: "net",
        current: net,
        previous: fact("glance.net.previous", "cents", 100_000),
        changePct: 23.5,
        change: changeFact("glance.net.change", 23.5),
      },
      {
        metric: "orders",
        current: fact("glance.orders", "count", 1_204),
        previous: null,
        changePct: null,
        change: null,
      },
    ],
    net,
    netChange: changeFact("glance.net.change", 23.5),
    steady: false,
    incompleteOrders: 3,
    partialChannels: ["amazon"],
    actions: [
      {
        id: "i1",
        detector: "D6",
        action: {
          kind: "ship_overdue",
          href: "/orders?view=overdue",
          params: { n: 4 },
        },
        facts: [fact("d6.overdueNow", "count", 4)],
      },
      {
        id: "i2",
        detector: "D4",
        action: { kind: "review_ads", href: "/analytics/ad-spend", params: { channel: "amazon" } },
        facts: [],
      },
    ],
    win: {
      id: "i3",
      detector: "D8",
      action: { kind: "none", href: "/analytics/profit", params: {} },
      facts: [fact("d8.net", "cents", 123_456), fact("d8.weeks", "count", 5)],
    },
    marketWatch: [],
    unsubscribeUrl: "http://localhost:3000/l/tok",
    manageUrl: "http://localhost:5173/settings/notifications",
  };

  it("P1: every rendered line is a template key with values from facts, shop data or links", () => {
    for (const lang of ["en", "es"] as const) {
      const parts = renderParts(model, lang);
      const allowed = new Set<string>([
        model.shopName,
        "Amazon",
        ...model.glance.flatMap((g) => [
          g.current.formatted[lang],
          g.change?.formatted[lang] ?? "",
          TEMPLATES[`glance.${g.metric}` as keyof typeof TEMPLATES][lang],
        ]),
        ...[...model.actions, model.win].flatMap(
          (i) => i?.facts.map((f) => f.formatted[lang]) ?? [],
        ),
        "3",
        "Sep 21, 2026",
        "Sep 27, 2026",
        "21 sept 2026",
        "27 sept 2026",
      ]);
      for (const p of parts) {
        expect(Object.keys(TEMPLATES)).toContain(p.key);
        for (const v of Object.values(p.vars)) expect([...allowed, ...[...allowed]]).toContain(v);
      }
      const mail = renderEmail(model, lang);
      expect(mail.text.split("\n")).toEqual(
        parts.map((p) => (p.href ? `${expand(p, lang)}: ${p.href}` : expand(p, lang))),
      );
    }
  });

  it("AC13: Spanish has every key, no English fallback and USD money; no raw keys", () => {
    for (const [key, row] of Object.entries(TEMPLATES)) {
      expect(row.es, key).toBeTruthy();
      const proper = /^(source\.|market\.source|glance\.rowFirst|week$)/.test(key);
      if (!proper && !/^(\{\{|Google|Pinterest|Jungle|Amazon Brand)/.test(row.en))
        expect(row.es, key).not.toBe(row.en);
    }
    const es = renderEmail(model, "es");
    expect(es.subject).toBe("Tu semana en Desert Fixture Tees: ganancia neta $1,234.56 (+23.5%)");
    expect(es.text).toContain("Envía 4 pedidos atrasados");
    expect(es.text).toContain("Los resultados de anuncios se miden por canal");
    expect(es.text).not.toMatch(/\{\{|\b[a-z]+\.[a-z]+[A-Z]\w*\b/);
    const en = renderEmail(model, "en");
    expect(en.subject).toBe("Your week at Desert Fixture Tees: net profit $1,234.56 (+23.5%)");
    expect(en.html).not.toMatch(/<script/i);
  });

  it("escapes shop-supplied names in HTML", () => {
    const evil = renderEmail({ ...model, shopName: '<img src=x onerror="1">' }, "en");
    expect(evil.html).not.toContain("<img");
    expect(evil.html).toContain("&lt;img");
  });
});

describe("a digest rendered on 2026-09-28 (wave 20, T-20-1 AC6)", () => {
  const WEEK_END = "2026-09-28";
  const src = {
    source: "google_trends",
    licence: "official_api",
    asOf: "2026-09-27T23:59:59.999Z",
    fetchedAt: "2026-09-28T07:00:00.000Z",
    mock: true,
  };
  const recs = [
    // Missed: act-by Aug 1 is before the week's end. Must never show.
    marketRec({
      id: "00000000-0000-4000-8000-0000000000b1",
      target: { designId: null, designName: "Old Ghost", niche: null, channel: null },
      params: { designName: "Old Ghost", peakMonth: 9, actByDate: "2026-08-01" },
      sources: [src],
    }),
    // Under way: the September peak, no act-by date.
    marketRec({
      id: "00000000-0000-4000-8000-0000000000b2",
      target: { designId: null, designName: "Spirit Tee", niche: null, channel: null },
      params: { designName: "Spirit Tee", peakMonth: 9, niche: "halloween" },
      sources: [src],
    }),
  ];
  const s = snapshot({
    current: { ...snapshot().current, orders: 40, marginPct: 33.4 },
    previous: { ...snapshot().previous, orders: 40, marginPct: 26.5 },
  });
  const glance = glanceOf(s);
  const candidates = marketCandidates(recs, { mockAllowed: true, weekEnd: WEEK_END });
  const model: RenderModel = {
    shopName: "Desert Fixture Tees",
    weekStart: "2026-09-21",
    weekEnd: WEEK_END,
    glance,
    net: null,
    netChange: null,
    steady: false,
    incompleteOrders: 0,
    partialChannels: [],
    actions: [],
    win: null,
    marketWatch: candidates.map((c, n) => ({
      id: `m${n}`,
      detector: "market",
      action: c.action,
      facts: c.facts,
      recommendation: c.recommendation,
    })),
    unsubscribeUrl: "http://localhost:3000/l/tok",
    manageUrl: "http://localhost:5173/settings/notifications",
  };

  it("drops the past-peak item and keeps the under-way one", () => {
    expect(candidates.map((c) => c.recommendation?.id)).toEqual([
      "00000000-0000-4000-8000-0000000000b2",
    ]);
  });

  it("en and es: no past month after 'before', no 'Mon,', margin in points, 'unchanged' orders", () => {
    const months = (lang: "en" | "es") =>
      Array.from({ length: 9 }, (_, m) =>
        new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", {
          month: "long",
          timeZone: "UTC",
        }).format(new Date(Date.UTC(2026, m, 1))),
      );
    const text = { en: renderEmail(model, "en").text, es: renderEmail(model, "es").text };
    for (const m of months("en")) expect(text.en).not.toMatch(new RegExp(`before ${m}`, "i"));
    for (const m of months("es")) expect(text.es).not.toMatch(new RegExp(`antes de ${m}`, "i"));
    expect(text.es).not.toContain("Mon,");
    for (const lang of ["en", "es"] as const) {
      expect(text[lang]).not.toMatch(/\(0%|\(\+26%|\+26\.0 pts/);
      expect(text[lang]).not.toContain("Old Ghost");
    }
    expect(text.en).toContain("Margin: 33.4% (+6.9 pts vs last week)");
    expect(text.es).toContain("(+6.9 pts vs. la semana pasada)");
    expect(text.en).toContain("Orders: 40 (unchanged vs last week)");
    expect(text.es).toContain("Pedidos: 40 (sin cambio vs. la semana pasada)");
    expect(text.en).toContain("The Halloween season is on now. Make sure Spirit Tee is listed");
    expect(text.es).toContain("La temporada de Halloween ya empezó.");
    expect(text.en).toContain("Google Trends, week ending Sep 27");
    expect(text.es).toContain("Google Trends, semana al 27 sep");
  });

  it("a negative point change and a relative change keep their own formats", () => {
    const down = glanceOf(
      snapshot({
        current: { ...snapshot().current, revenue: 36_000, marginPct: 26.5 },
        previous: { ...snapshot().previous, revenue: 30_000, marginPct: 33.4 },
      }),
    );
    const margin = down.find((g) => g.metric === "marginPct");
    expect(margin?.change?.formatted).toEqual({ en: "-6.9 pts", es: "-6.9 pts" });
    expect(margin?.changePct).toBe(-6.9);
    expect(down.find((g) => g.metric === "revenue")?.change?.formatted.en).toBe("+20%");
  });
});
