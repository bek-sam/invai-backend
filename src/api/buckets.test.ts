import type { ProcedureMeta } from "@invai/contracts";
import { contract, listProcedures } from "@invai/contracts";
import { call } from "@orpc/server";
import { beforeAll, describe, expect, it } from "vitest";
import { redis } from "../lib/queues";
import { checkRateLimit, RATE_BUCKET_LIMITS, rateLimitKey } from "../lib/ratelimit";
import { createCompany, createUser } from "../test/fixtures";
import { anonymousContext, type Context, permissionsFor } from "./context";
import {
  AI_BUCKET_PROCEDURES,
  AI_CHEAP_READS,
  bucketFor,
  NON_GET_READS,
  SCAN_BUCKET_PROCEDURES,
} from "./orpc";
import { router } from "./router";

/*
 * B-133 (wave 18 gate, issue 1): the web polls `ai.credits.balance` and lists conversations,
 * cheap reads that never call a model, yet they drained the 20/min `ai` bucket and blocked the
 * assistant's `ask`. They now count against `reads`; every model-calling procedure stays in `ai`.
 */

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  return node as AnyProcedure;
}

function userContext(companyId: string, userId: string): Context {
  return {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: userId, name: "Owner", email: "owner@test.local" },
    emailVerified: true,
    companyId,
    orgType: "shop",
    role: "owner",
    permissions: permissionsFor("owner"),
    resHeaders: new Headers(),
  };
}

/** `call()` has no router path unless told; the limiter classifies by it, so pass the real one. */
const BALANCE = ["ai", "credits", "balance"] as const;

const NO_SESSION = { sessionKind: "user" as const, stationId: null };

const meta = (auth?: ProcedureMeta["auth"]): ProcedureMeta =>
  ({ permission: "org.read", auth }) as unknown as ProcedureMeta;

describe("bucketFor (B-133)", () => {
  it("routes the cheap ai reads to reads and every model-calling ai procedure to ai", () => {
    for (const name of AI_CHEAP_READS)
      expect(bucketFor(name.split("."), meta(), "GET", NO_SESSION)).toBe("reads");
    expect(bucketFor(["ai", "assistant", "ask"], meta(), "POST", NO_SESSION)).toBe("ai");
    expect(bucketFor(["ai", "listings", "create"], meta(), "POST", NO_SESSION)).toBe("ai");
    expect(bucketFor(["ai", "listings", "regenerate"], meta(), "POST", NO_SESSION)).toBe("ai");
    expect(bucketFor(["ai", "tools", "trademarkCheck"], meta(), "POST", NO_SESSION)).toBe("ai");
    expect(bucketFor(["orders", "list"], meta(), "GET", NO_SESSION)).toBe("reads");
    expect(bucketFor(["orders", "hold"], meta(), "POST", NO_SESSION)).toBe("writes");
    expect(bucketFor(["floor", "login"], meta("station"), "POST", NO_SESSION)).toBe("auth");
  });

  it("routes the credit-spending photos procedures to ai and the photo estimate to reads (ADR 0023)", () => {
    for (const name of AI_BUCKET_PROCEDURES)
      expect(bucketFor(name.split("."), meta(), "POST", NO_SESSION)).toBe("ai");
    expect(bucketFor(["photos", "estimate"], meta(), "POST", NO_SESSION)).toBe("reads");
    expect(bucketFor(["photos", "reviewImages"], meta(), "POST", NO_SESSION)).toBe("writes");
  });

  it("25 credit-balance reads in a minute do not block an ask; the 21st ask is still limited", async () => {
    const company = await createCompany();
    const user = await createUser(company.id, "owner");
    const ctx = userContext(company.id, user.id);
    for (let i = 0; i < 25; i++) {
      const res = (await call(
        procedureAt("ai.credits.balance"),
        {},
        { context: ctx, path: BALANCE },
      )) as {
        remaining: number;
      };
      expect(typeof res.remaining).toBe("number");
    }
    // The ai bucket is still full: all 20 tokens can be taken.
    const ai = RATE_BUCKET_LIMITS.ai;
    for (let i = 0; i < ai.capacity; i++) {
      expect((await checkRateLimit("ai", company.id, ai)).allowed).toBe(true);
    }
    // ...and now the 21st ai call in the minute is refused before the handler (no model call).
    // `ask` streams, so the middleware's error surfaces when the iterator is consumed.
    const asked = await call(
      procedureAt("ai.assistant.ask"),
      { message: "hello" },
      { context: ctx, path: ["ai", "assistant", "ask"] },
    ).then(
      async (out) => {
        const events: unknown[] = [];
        for await (const e of out as AsyncIterable<unknown>) events.push(e);
        return { events };
      },
      (err: unknown) => ({ error: err as { code?: string } }),
    );
    expect(asked).toMatchObject({ error: { code: "RATE_LIMITED" } });
    // Reads are separate: the balance still answers.
    const still = (await call(
      procedureAt("ai.credits.balance"),
      {},
      { context: ctx, path: BALANCE },
    )) as {
      remaining: number;
    };
    expect(typeof still.remaining).toBe("number");
  });
});

describe("rate limit buckets: sanity", () => {
  beforeAll(() => {
    expect(RATE_BUCKET_LIMITS.links.capacity).toBe(60);
  });
  it("keeps the ai bucket small and the links bucket separate", () => {
    expect(RATE_BUCKET_LIMITS.ai.capacity).toBe(20);
    expect(RATE_BUCKET_LIMITS.reads.capacity).toBeGreaterThan(RATE_BUCKET_LIMITS.ai.capacity);
  });
});

/*
 * T-P3-1 (B-236): a 429 on a real `production.scan` right after a burst of `files.downloadUrl`
 * calls (root cause: `waves/P2/reports/gate-rootcause.md`) because `bucketFor` used to bucket
 * every non-GET procedure as `writes`, with no check for whether it actually writes anything.
 * This pins that classification so a future non-GET procedure with a read permission can't land
 * silently in `writes` (and drain a real mutation's budget) or in `reads` (and skip a control it
 * needs): it must be added to one list below, with a reason, or this test fails.
 *
 * `ai.*` and `auth: "station"` procedures are excluded from the walk: they're bucketed by
 * `AI_CHEAP_READS` and the `auth` bucket before `bucketFor` even reaches the GET/NON_GET_READS
 * check (AC2 of the card: both stay unchanged here).
 */
const READ_PERMISSION = /\.read$/;

/**
 * Every non-GET, non-ai, non-station procedure whose permission ends in `.read`, that is NOT a
 * pure read in effect, with the reason it stays in `writes`. Checked by hand against its
 * handler (T-P3-1 report has the file:line for each).
 */
const STAYS_WRITES: ReadonlySet<string> = new Set([
  "me.notifications.set", // writes the caller's own email-preference row
  "demo.start", // (re)builds the whole demo company's data
  "demo.reset", // wipes and rebuilds the whole demo company's data
  "demo.leave", // tears down the demo company and switches org
  "today.dismissChecklist", // writes the checklist-dismissed flag
  "today.recordActionClick", // writes a click record
  "alerts.markRead", // writes alert read state
  "alerts.markAllRead", // writes alert read state for every alert
  "orders.addNote", // writes an audit row and a timeline entry
  "personalization.templates.preview", // calls imaging (outbound render) and writes the preview PNG to storage
  "inventory.suppliers.stock", // calls the live supplier adapter per blank (outbound network call)
  "shipping.batchLabelPdf", // writes a merged label PDF to storage
  "finance.exportCsv", // writes a profit CSV to storage
  "analytics.export", // writes an analytics CSV to storage
  "market.recommendations.vote", // writes the recommendation's vote/outcome
  "digest.feedback", // writes a feedback row
  "digest.recordClick", // writes a digest-click row
]);

describe("non-GET read-permission procedures are classified by hand (T-P3-1, B-236)", () => {
  const nonGetReads = listProcedures(contract).filter(
    (p) =>
      p.method !== "GET" &&
      p.meta.auth !== "station" &&
      p.path.split(".")[0] !== "ai" &&
      READ_PERMISSION.test(p.meta.permission),
  );

  it("found at least the known cases, so the filter itself still matches the contract", () => {
    expect(nonGetReads.length).toBeGreaterThanOrEqual(NON_GET_READS.size + STAYS_WRITES.size);
  });

  it("every one is in NON_GET_READS or STAYS_WRITES, and bucketFor agrees with the list", () => {
    for (const p of nonGetReads) {
      const inReads = NON_GET_READS.has(p.path);
      const inWrites = STAYS_WRITES.has(p.path);
      expect(
        inReads || inWrites,
        `${p.path} (permission ${p.meta.permission}, method ${p.method}) is not classified in ` +
          "NON_GET_READS or STAYS_WRITES -- decide whether its handler writes, enqueues, sends, " +
          "signs an upload or calls an outbound/paid service, then add it to one list with a reason",
      ).toBe(true);
      expect(inReads && inWrites, `${p.path} is in both lists`).toBe(false);
      expect(bucketFor(p.path.split("."), p.meta, p.method, NO_SESSION)).toBe(
        inReads ? "reads" : "writes",
      );
    }
  });

  it("every NON_GET_READS entry really is a non-GET procedure with a read permission", () => {
    const paths = new Set(nonGetReads.map((p) => p.path));
    for (const path of NON_GET_READS) expect(paths.has(path), path).toBe(true);
  });
});

/*
 * T-37-5 (B-362): `files.downloadUrls` carries up to 60 keys but costs one `reads` token per
 * call, whatever the keys are (even all unreadable), and needs `files.read`.
 */
describe("files.downloadUrls bucket and permission (T-37-5)", () => {
  const DL = ["files", "downloadUrls"] as const;
  const readsTokens = async (companyId: string) =>
    Number(await redis.hget(rateLimitKey("reads", companyId), "tokens"));

  it("is classified as reads even though it is a POST", () => {
    expect(NON_GET_READS.has("files.downloadUrls")).toBe(true);
    expect(bucketFor(["files", "downloadUrls"], meta(), "POST", NO_SESSION)).toBe("reads");
  });

  it("one call costs exactly one reads token, also when every key is null", async () => {
    const company = await createCompany();
    const user = await createUser(company.id, "owner");
    const ctx = userContext(company.id, user.id);
    const keys = Array.from({ length: 60 }, (_, i) => `${company.id}/artwork/none-${i}.png`);
    // First call creates the bucket; compare the second and third.
    await call(
      procedureAt("files.downloadUrls"),
      { fileKeys: [keys[0]] },
      { context: ctx, path: DL },
    );
    const before = await readsTokens(company.id);
    const res = (await call(
      procedureAt("files.downloadUrls"),
      { fileKeys: keys },
      { context: ctx, path: DL },
    )) as { items: { download: unknown }[] };
    const after = await readsTokens(company.id);
    expect(res.items).toHaveLength(60);
    expect(res.items.every((i) => i.download === null)).toBe(true);
    // Refill adds a sliver between calls; a per-key cost would have dropped it by about 60.
    expect(before - after).toBeGreaterThan(0.5);
    expect(before - after).toBeLessThan(1.5);
  });

  it("a caller without files.read gets FORBIDDEN", async () => {
    const company = await createCompany();
    const user = await createUser(company.id, "owner");
    const ctx: Context = { ...userContext(company.id, user.id), permissions: new Set() };
    await expect(
      call(procedureAt("files.downloadUrls"), { fileKeys: ["a"] }, { context: ctx, path: DL }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

/*
 * T-56-1 (B-479, ADR 0040): every `auth: "floor"` non-GET procedure is classified by hand. The
 * scan set takes the `scans` buckets from a floor session at a station; the rest stays in
 * `writes` (or `reads` for the pure reads), each with a reason.
 */
const FLOOR_STAYS_WRITES: Record<string, string> = {
  "production.reprints.request": "creates a reprint request row and an outbox event",
  "production.sheets.markReceived": "moves a sheet's state and writes inventory",
  "inventory.purchaseOrders.receive": "writes stock movements",
  "inventory.adjust": "writes stock movements",
  "inventory.count": "writes stock movements",
  "shipping.rates": "calls the live carrier (outbound, costs a rate call)",
  "shipping.buy": "buys postage: money stays out of the scan buckets",
  "shipping.batchLabelPdf": "writes a merged label PDF to storage",
  "alerts.markRead": "writes alert read state",
  "floor.logout": "revokes the floor session",
};

describe("floor non-GET procedures are classified by hand (T-56-1, B-479)", () => {
  const floorWrites = listProcedures(contract).filter(
    (p) => p.meta.auth === "floor" && p.method !== "GET",
  );
  const floorSession = { sessionKind: "floor" as const, stationId: "s1" };

  it("every one is in the scan set, the stays-writes list or NON_GET_READS", () => {
    for (const p of floorWrites) {
      const n = [
        SCAN_BUCKET_PROCEDURES.has(p.path),
        p.path in FLOOR_STAYS_WRITES,
        NON_GET_READS.has(p.path),
      ];
      expect(
        n.filter(Boolean).length,
        `${p.path} must be in exactly one of: SCAN_BUCKET_PROCEDURES, FLOOR_STAYS_WRITES, NON_GET_READS`,
      ).toBe(1);
      const want = n[0] ? "scans" : n[2] ? "reads" : "writes";
      expect(bucketFor(p.path.split("."), p.meta, p.method, floorSession), p.path).toBe(want);
    }
  });

  it("the scan set is exactly the five tablet writes and all exist in the contract", () => {
    expect([...SCAN_BUCKET_PROCEDURES].sort()).toEqual([
      "production.bins.assign",
      "production.bins.release",
      "production.packOrder",
      "production.qc",
      "production.scan",
    ]);
    const paths = new Set(floorWrites.map((p) => p.path));
    for (const name of SCAN_BUCKET_PROCEDURES) expect(paths.has(name), name).toBe(true);
    for (const name of Object.keys(FLOOR_STAYS_WRITES)) expect(paths.has(name), name).toBe(true);
  });

  it("scans applies only to a floor session with a station; everything else keeps today's rules", () => {
    const p = ["production", "scan"];
    expect(bucketFor(p, meta(), "POST", { sessionKind: "floor", stationId: "s1" })).toBe("scans");
    expect(bucketFor(p, meta(), "POST", { sessionKind: "user", stationId: null })).toBe("writes");
    expect(bucketFor(p, meta(), "POST", { sessionKind: "user", stationId: "s1" })).toBe("writes");
    expect(bucketFor(p, meta(), "POST", { sessionKind: "floor", stationId: null })).toBe("writes");
    expect(bucketFor(p, meta(), "POST", { sessionKind: null, stationId: null })).toBe("writes");
    expect(bucketFor(["shipping", "batchBuy"], meta(), "POST", floorSession)).toBe("writes");
  });

  it("a station-token session (sessionKind station) is never on scans (B-487)", () => {
    const p = ["production", "scan"];
    expect(bucketFor(p, meta(), "POST", { sessionKind: "station", stationId: "s1" })).toBe(
      "writes",
    );
  });
});
