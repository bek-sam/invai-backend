import { eq } from "drizzle-orm";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "../../db/client";
import { aiJobs } from "../../db/schema";
import { env } from "../../env";
import { redis } from "../../lib/queues";
import { createCompany } from "../../test/fixtures";
import { platformSpendKey, spendDay, tenantSpendKey } from "../breaker";
import { assertImageGenAllowed, buildScenePrompt, ImageGenError, recordImageGen } from "./index";
import { createOpenAiImageProvider } from "./openai";
import { encodePng } from "./png";

/*
 * Security-reviewer suite for the image provider (T-27-1 co-review). Stubbed HTTP only, never a
 * real call. S-53: a timed-out OpenAI edit may already be billed, yet it records 0 cents and does
 * not count toward the shop's daily cap, so while OpenAI is slow neither the shop cap nor the
 * spend breaker bounds real spend. Remove `.fails` once the fix lands (owner: ai-engineer).
 */

type MutableEnv = {
  IMAGE_GEN_DAILY_CAP_PER_SHOP: number;
  AI_DAILY_PLATFORM_CAP_CENTS: number;
  AI_DAILY_TENANT_CAP_CENTS: number;
};
const menv = env as unknown as MutableEnv;
const saved = { ...menv };
afterEach(() => {
  Object.assign(menv, {
    IMAGE_GEN_DAILY_CAP_PER_SHOP: saved.IMAGE_GEN_DAILY_CAP_PER_SHOP,
    AI_DAILY_PLATFORM_CAP_CENTS: saved.AI_DAILY_PLATFORM_CAP_CENTS,
    AI_DAILY_TENANT_CAP_CENTS: saved.AI_DAILY_TENANT_CAP_CENTS,
  });
});

function hangingClient() {
  const fetchStub = async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  Object.assign(fetchStub, { Response });
  return new OpenAI({
    apiKey: "sk-test-not-a-key",
    baseURL: "http://openai.stub.invalid/v1",
    maxRetries: 0,
    timeout: 50,
    fetch: fetchStub as typeof fetch,
  });
}

function tinyPng(): Buffer {
  const w = 8;
  const h = 8;
  return encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(255) });
}

describe("image spend controls (security, S-53)", () => {
  it("a timed-out paid call is charged conservatively and counts toward the shop cap", async () => {
    menv.IMAGE_GEN_DAILY_CAP_PER_SHOP = 2;
    menv.AI_DAILY_PLATFORM_CAP_CENTS = 0;
    menv.AI_DAILY_TENANT_CAP_CENTS = 0;
    const shop = await createCompany();
    const day = spendDay(new Date());
    const tKey = tenantSpendKey(shop.id, day);
    const provider = createOpenAiImageProvider(() => hangingClient());
    const prompt = buildScenePrompt(null, "studio", "tee", "Black");
    const png = tinyPng();
    try {
      for (let i = 0; i < 2; i++) {
        const err = await provider
          .generateScene({ baseImage: png, mask: png, prompt, sizePx: 1024 })
          .catch((e) => e);
        expect((err as Error).message).toMatch(/timed out/);
        await recordImageGen({
          companyId: shop.id,
          userId: null,
          prompt,
          provider,
          result: null,
          error: err,
        });
      }
      // The provider may have billed both calls: spend counters must not stay at zero...
      expect(Number(await redis.get(tKey))).toBeGreaterThanOrEqual(
        2 * provider.estimateCents(1024),
      );
      // ...and the shop's daily cap must stop a third paid attempt.
      const refused = await withTenant(shop.id, (tx) =>
        assertImageGenAllowed(tx, shop.id, 1, { provider }).then(
          () => null,
          (e) => (e as { code?: string }).code,
        ),
      );
      expect(refused).toBe("IMAGE_DAILY_CAP_REACHED");
    } finally {
      await redis.del(tKey, platformSpendKey(day));
    }
  });
});

/*
 * S-77 (T-43-2 security co-review, fixed in T-45-2): `generateScene` used to retry a 5xx once inside
 * the provider, so one call could cost two estimates while the ledger, the spend counters and the
 * scene-trial --max-calls wrapper saw one. The retry is dropped: one call is one HTTP request, and
 * the failed call books the estimate once.
 */
function fiveHundredThenOk(image: Buffer) {
  let requests = 0;
  const fetchStub = async () => {
    requests += 1;
    if (requests === 1)
      return new Response(JSON.stringify({ error: { message: "busy" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    return new Response(
      JSON.stringify({ created: 1, data: [{ b64_json: image.toString("base64") }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  Object.assign(fetchStub, { Response });
  const client = new OpenAI({
    apiKey: "sk-test-not-a-key",
    baseURL: "http://openai.stub.invalid/v1",
    maxRetries: 0,
    timeout: 5_000,
    fetch: fetchStub as typeof fetch,
  });
  return { client, requests: () => requests };
}

describe("image spend controls (security, S-77)", () => {
  it("a 5xx is one request, booked once at the estimate on the ledger and both spend counters", async () => {
    menv.AI_DAILY_PLATFORM_CAP_CENTS = 0;
    menv.AI_DAILY_TENANT_CAP_CENTS = 0;
    const shop = await createCompany();
    const day = spendDay(new Date());
    const tKey = tenantSpendKey(shop.id, day);
    const pKey = platformSpendKey(day);
    const png = tinyPng();
    const stub = fiveHundredThenOk(png);
    const provider = createOpenAiImageProvider(() => stub.client);
    const prompt = buildScenePrompt(null, "studio", "tee", "Black");
    const est = provider.estimateCents(1024);
    try {
      const platformBefore = Number(await redis.get(pKey)) || 0;
      const error = await provider
        .generateScene({ baseImage: png, mask: png, prompt, sizePx: 1024 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(ImageGenError);
      expect((error as ImageGenError).mayBeBilled).toBe(true);
      await recordImageGen({
        companyId: shop.id,
        userId: null,
        prompt,
        provider,
        result: null,
        error,
      });
      expect(stub.requests()).toBe(1);
      expect(Number(await redis.get(tKey))).toBe(est);
      expect(Number(await redis.get(pKey)) - platformBefore).toBe(est);
      const rows = await withTenant(shop.id, (tx) =>
        tx.select().from(aiJobs).where(eq(aiJobs.companyId, shop.id)),
      );
      expect(rows.map((r) => r.costCents)).toEqual([est]);
    } finally {
      await redis.del(tKey, pKey);
    }
  });
});

/*
 * T-45-2 r2: the production default client (no injected client) must not retry. openai.ts builds it
 * with maxRetries 0; the SDK default is 2, so a 5xx or a dropped connection would otherwise send
 * three billable requests per generateScene. Fresh module graph per test (the client is a module
 * singleton), fake key, unroutable stub host, global fetch stubbed: nothing leaves the process.
 */
describe("default OpenAI image client sends one request (security, T-45-2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  for (const mode of ["503", "connection error"] as const) {
    it(`one generateScene is one request on a ${mode}`, async () => {
      vi.resetModules();
      vi.stubEnv("OPENAI_BASE_URL", "http://openai.stub.invalid/v1");
      const fresh = await import("../../env");
      (fresh.env as unknown as { OPENAI_API_KEY: string }).OPENAI_API_KEY = "sk-test-not-a-key";
      const { createOpenAiImageProvider: create } = await import("./openai");
      const hosts: string[] = [];
      const fetchStub = async (url: string | URL | Request) => {
        hosts.push(new URL(String(url)).host);
        if (mode === "connection error") throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ error: { message: "busy" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      };
      Object.assign(fetchStub, { Response });
      vi.stubGlobal("fetch", fetchStub);
      const png = tinyPng();
      const prompt = buildScenePrompt(null, "studio", "tee", "Black");
      const error = await create()
        .generateScene({ baseImage: png, mask: png, prompt, sizePx: 1024 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("ImageGenError");
      expect(hosts).toEqual(["openai.stub.invalid"]);
    });
  }
});
