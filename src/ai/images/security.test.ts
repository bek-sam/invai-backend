import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "../../db/client";
import { env } from "../../env";
import { redis } from "../../lib/queues";
import { createCompany } from "../../test/fixtures";
import { platformSpendKey, spendDay, tenantSpendKey } from "../breaker";
import { assertImageGenAllowed, buildScenePrompt, recordImageGen } from "./index";
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
 * S-77 (T-43-2 security co-review): `generateScene` retries a 5xx once inside the provider. The
 * code's own billing model (mapError, S-53) says a 5xx may already be billed, yet when the retry
 * succeeds only the success is recorded, so one call can cost two estimates while the ledger, the
 * spend counters and any per-call limit (the scene-trial --max-calls wrapper) see one. Remove
 * `.fails` once a 5xx-then-success books both requests or the in-provider retry is dropped
 * (owner: ai-engineer).
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
  it.fails("a 5xx retried inside the provider is booked for every request that may be billed", async () => {
    menv.AI_DAILY_PLATFORM_CAP_CENTS = 0;
    menv.AI_DAILY_TENANT_CAP_CENTS = 0;
    const shop = await createCompany();
    const day = spendDay(new Date());
    const tKey = tenantSpendKey(shop.id, day);
    const png = tinyPng();
    const stub = fiveHundredThenOk(png);
    const provider = createOpenAiImageProvider(() => stub.client);
    const prompt = buildScenePrompt(null, "studio", "tee", "Black");
    try {
      const result = await provider.generateScene({
        baseImage: png,
        mask: png,
        prompt,
        sizePx: 1024,
      });
      await recordImageGen({ companyId: shop.id, userId: null, prompt, provider, result });
      expect(stub.requests()).toBe(2);
      expect(Number(await redis.get(tKey))).toBeGreaterThanOrEqual(
        stub.requests() * provider.estimateCents(1024),
      );
    } finally {
      await redis.del(tKey, platformSpendKey(day));
    }
  });
});
