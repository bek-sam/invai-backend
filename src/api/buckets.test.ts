import type { ProcedureMeta } from "@invai/contracts";
import { contract, listProcedures } from "@invai/contracts";
import { call } from "@orpc/server";
import { beforeAll, describe, expect, it } from "vitest";
import { checkRateLimit, RATE_BUCKET_LIMITS } from "../lib/ratelimit";
import { createCompany, createUser } from "../test/fixtures";
import { anonymousContext, type Context, permissionsFor } from "./context";
import { AI_CHEAP_READS, bucketFor, NON_GET_READS } from "./orpc";
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

const meta = (auth?: ProcedureMeta["auth"]): ProcedureMeta =>
  ({ permission: "org.read", auth }) as unknown as ProcedureMeta;

describe("bucketFor (B-133)", () => {
  it("routes the cheap ai reads to reads and every model-calling ai procedure to ai", () => {
    for (const name of AI_CHEAP_READS)
      expect(bucketFor(name.split("."), meta(), "GET")).toBe("reads");
    expect(bucketFor(["ai", "assistant", "ask"], meta(), "POST")).toBe("ai");
    expect(bucketFor(["ai", "listings", "create"], meta(), "POST")).toBe("ai");
    expect(bucketFor(["ai", "listings", "regenerate"], meta(), "POST")).toBe("ai");
    expect(bucketFor(["ai", "tools", "trademarkCheck"], meta(), "POST")).toBe("ai");
    expect(bucketFor(["orders", "list"], meta(), "GET")).toBe("reads");
    expect(bucketFor(["orders", "hold"], meta(), "POST")).toBe("writes");
    expect(bucketFor(["floor", "login"], meta("station"), "POST")).toBe("auth");
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
      expect(bucketFor(p.path.split("."), p.meta, p.method)).toBe(inReads ? "reads" : "writes");
    }
  });

  it("every NON_GET_READS entry really is a non-GET procedure with a read permission", () => {
    const paths = new Set(nonGetReads.map((p) => p.path));
    for (const path of NON_GET_READS) expect(paths.has(path), path).toBe(true);
  });
});
