import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_PROMPT,
  CONTROL_PROMPT_REF,
  controlGate,
  runControl,
} from "../../../evals/scene_trial/control";
import {
  budgetVerdict,
  computeCaps,
  createCallLimiter,
  dayEndRefusal,
  ledgerCents,
  limitProviderCalls,
  maxCallsFor,
  paidInputsRefusal,
  paidRunRefusal,
  parseChannels,
  parseKinds,
  parseMaxCalls,
  promptLabelForBlank,
  worstCaseCents,
} from "../../../evals/scene_trial/guard";
import { withSystem, withTenant } from "../../db/client";
import { aiJobs, photoImages } from "../../db/schema";
import { env } from "../../env";
import { imaging } from "../../integrations/imaging/client";
import { getObject, putObject } from "../../lib/s3";
import { createCompany } from "../../test/fixtures";
import { getImageProvider, ImageGenError, type ImageProvider, mockImageProvider } from "./index";
import { encodePng } from "./png";

/*
 * T-38-2: the scene trial runner's spend guard and the control call, with the mock provider and
 * stubbed imaging. No real provider is ever called here.
 */

type MutableEnv = { IMAGE_GEN_DAILY_CAP_PER_SHOP: number };
const menv = env as unknown as MutableEnv;
const savedCap = menv.IMAGE_GEN_DAILY_CAP_PER_SHOP;
afterEach(() => {
  menv.IMAGE_GEN_DAILY_CAP_PER_SHOP = savedCap;
  vi.restoreAllMocks();
});

describe("budgetVerdict", () => {
  it("allows a run under and exactly at the budget, refuses one over it", () => {
    expect(budgetVerdict({ ledger: 100, worstCase: 132, budget: 600 }).ok).toBe(true);
    expect(budgetVerdict({ ledger: 468, worstCase: 132, budget: 600 }).ok).toBe(true);
    const over = budgetVerdict({ ledger: 469, worstCase: 132, budget: 600 });
    expect(over.ok).toBe(false);
    expect(over.reason).toContain("601c exceeds the budget 600c");
    expect(budgetVerdict({ ledger: 0, worstCase: 11, budget: 1 }).ok).toBe(false);
  });
});

describe("ledgerCents", () => {
  it("sums every openai row (any kind) created since the given time, and nothing older or non-openai", async () => {
    const shop = await createCompany();
    const since = new Date("2031-03-01T00:00:00Z");
    const row = (createdAt: Date, costCents: number, kind: "image_scene" | "listing_draft") => ({
      companyId: shop.id,
      kind,
      status: "done" as const,
      provider: "openai" as const,
      model: "gpt-image-2",
      input: {},
      output: {},
      costCents,
      credits: 0,
      createdAt,
    });
    await withTenant(shop.id, (tx) =>
      tx.insert(aiJobs).values([
        row(new Date("2031-02-28T23:59:59Z"), 50, "image_scene"),
        row(new Date("2031-03-01T00:00:00Z"), 11, "image_scene"),
        row(new Date("2031-03-02T10:00:00Z"), 22, "image_scene"),
        row(new Date("2031-03-02T10:00:00Z"), 99, "listing_draft"),
        {
          ...row(new Date("2031-03-02T10:00:00Z"), 500, "listing_draft"),
          provider: "mock" as const,
        },
      ]),
    );
    expect(await ledgerCents(since)).toBe(132);
    expect(await ledgerCents(new Date("2031-03-02T00:00:00Z"))).toBe(121);
    expect(await ledgerCents(new Date("2031-04-01T00:00:00Z"))).toBe(0);
  });
});

describe("control gate and prompt", () => {
  it("stops before trial A when check 1 fails with registration under 0.5", () => {
    expect(controlGate({ failures: ["region_changed"], registration: 0.2 }).stop).toBe(true);
    expect(controlGate({ failures: ["region_changed"], registration: null }).stop).toBe(true);
    expect(controlGate({ failures: ["region_changed"], registration: 0.93 }).stop).toBe(false);
    expect(controlGate({ failures: [], registration: 0.2 }).stop).toBe(false);
  });

  it("is fixed text under its own ref, with no shop text and no person added", () => {
    expect(CONTROL_PROMPT.ref).toBe(CONTROL_PROMPT_REF);
    expect(CONTROL_PROMPT_REF).toBe("scene_control@1");
    expect(CONTROL_PROMPT.text).toMatch(/change nothing/i);
    expect(CONTROL_PROMPT.containsPerson).toBe(true);
  });
});

describe("runControl (mock provider, imaging stubbed)", () => {
  const png = () => {
    const n = 8;
    return encodePng({ width: n, height: n, data: new Uint8Array(n * n * 4).fill(255) });
  };
  const design = { fileKey: "x/design.png", widthIn: 10, heightIn: 11 };

  async function stub(companyId: string) {
    const base = `${companyId}/photos/control/test-base.png`;
    const mask = `${companyId}/photos/control/test-mask.png`;
    await putObject(base, png(), "image/png");
    await putObject(mask, png(), "image/png");
    vi.spyOn(imaging, "photoSceneBase").mockResolvedValue({
      key: base,
      mask_key: mask,
      print_box_px: [1, 1, 5, 5],
    });
    return vi.spyOn(imaging, "photoSceneComposite").mockResolvedValue({
      key: null,
      checks: {
        passes: false,
        failures: ["region_changed"],
        region_unchanged_score: 0.4,
        design_lock_score: 0.9,
        region_reasons: ["outline_low"],
        structural: true,
      },
      registration: { score: 0.31 },
    });
  }

  it("makes one call, records one ai_job under scene_control@1, no image row, no credits, 0c", async () => {
    const shop = await createCompany();
    const composite = await stub(shop.id);
    const gen = vi.spyOn(mockImageProvider, "generateScene");
    const r = await runControl({
      companyId: shop.id,
      userId: null,
      provider: mockImageProvider,
      design,
      colorHex: "#ffffff",
    });
    expect(gen).toHaveBeenCalledTimes(1);
    expect(composite).toHaveBeenCalledTimes(1);
    expect(r.scores).toMatchObject({ passes: false, registration: 0.31, c1: 0.4, lock: 0.9 });
    expect(controlGate(r.scores).stop).toBe(true);
    const rows = await withTenant(shop.id, (tx) =>
      tx.select().from(aiJobs).where(eq(aiJobs.companyId, shop.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "image_scene",
      credits: 0,
      costCents: 0,
      entityId: null,
    });
    expect(rows[0]?.input).toMatchObject({ prompt: "scene_control@1" });
    const images = await withSystem((tx) =>
      tx.select({ id: photoImages.id }).from(photoImages).where(eq(photoImages.companyId, shop.id)),
    );
    expect(images).toHaveLength(0);
    expect((await getObject(r.keys.scene)).length).toBeGreaterThan(0);
  });

  it("the daily cap sees the control call: at the cap it is refused before the provider is called", async () => {
    const shop = await createCompany();
    await stub(shop.id);
    menv.IMAGE_GEN_DAILY_CAP_PER_SHOP = 1;
    const input = {
      companyId: shop.id,
      userId: null,
      provider: mockImageProvider,
      design,
      colorHex: "#ffffff",
    };
    await runControl(input);
    const gen = vi.spyOn(mockImageProvider, "generateScene");
    await expect(runControl(input)).rejects.toMatchObject({ code: "IMAGE_DAILY_CAP_REACHED" });
    expect(gen).not.toHaveBeenCalled();
  });

  it("a failed provider call is recorded and rethrown", async () => {
    const shop = await createCompany();
    await stub(shop.id);
    const failing: ImageProvider = {
      ...mockImageProvider,
      generateScene: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      runControl({ companyId: shop.id, userId: null, provider: failing, design, colorHex: "#fff" }),
    ).rejects.toThrow("boom");
    const rows = await withTenant(shop.id, (tx) =>
      tx.select().from(aiJobs).where(eq(aiJobs.companyId, shop.id)),
    );
    expect(rows.map((x) => x.status)).toEqual(["failed"]);
  });
});

describe("paidRunRefusal (runner refusals, B-370)", () => {
  const ok = {
    paid: true,
    requestedOpenAi: true,
    yesPaid: true,
    providerName: "openai",
    ledger: 0,
    worstCase: 100,
    budget: 300,
  };
  it("lets a mock run through with no flags", () => {
    expect(
      paidRunRefusal({
        ...ok,
        paid: false,
        requestedOpenAi: false,
        yesPaid: false,
        providerName: "mock",
      }),
    ).toBeNull();
  });
  it("lets a paid run through when every guard holds", () => {
    expect(paidRunRefusal(ok)).toBeNull();
  });
  it("refuses when the provider resolved to openai but the env did not ask for it", () => {
    expect(paidRunRefusal({ ...ok, requestedOpenAi: false })).toMatch(
      /IMAGE_GEN_PROVIDER=openai is not set/,
    );
  });
  it("refuses a paid run without --yes-paid", () => {
    expect(paidRunRefusal({ ...ok, yesPaid: false })).toMatch(/needs --yes-paid/);
  });
  it("refuses when openai was requested but the provider resolved to the mock", () => {
    expect(paidRunRefusal({ ...ok, paid: false, providerName: "mock" })).toMatch(
      /resolved to mock.*INVAI_PAID_AI=1/,
    );
  });
  it("refuses before any call when the ledger is at or over the budget, or the worst case would pass it", () => {
    expect(paidRunRefusal({ ...ok, ledger: 300 })).toMatch(/refused before any call/);
    expect(paidRunRefusal({ ...ok, ledger: 450 })).toMatch(/refused before any call/);
    expect(paidRunRefusal({ ...ok, ledger: 250 })).toMatch(/exceeds the budget 300c/);
    expect(paidRunRefusal({ ...ok, budget: 1 })).toMatch(/refused before any call/);
  });
  it("checks the env request first, then --yes-paid, then the resolved provider", () => {
    const all = { ...ok, requestedOpenAi: false, yesPaid: false, paid: false };
    expect(paidRunRefusal({ ...all, paid: true })).toMatch(/not set/);
    expect(paidRunRefusal({ ...all, requestedOpenAi: true })).toMatch(/--yes-paid/);
  });
});

describe("parseKinds (--kinds)", () => {
  it("is null without the flag", () => {
    expect(parseKinds(null, 6)).toBeNull();
  });
  it("returns the kinds in order when there is one per scene", () => {
    expect(parseKinds("studio, studio,home", 3)).toEqual(["studio", "studio", "home"]);
  });
  it("rejects an unknown kind and a wrong count", () => {
    expect(() => parseKinds("studio,beach", 2)).toThrow(/"beach" is not a scene kind/);
    expect(() => parseKinds("studio,home", 3)).toThrow(/exactly 3 kinds/);
  });
});

describe("worst case (T-41-5 A13)", () => {
  it("is scenes x 2 calls x price plus 33c, one call plus 33c for the control", () => {
    expect(worstCaseCents({ scenes: 6, control: false, perImage: 11 })).toBe(165);
    expect(worstCaseCents({ scenes: 2, control: false, perImage: 11 })).toBe(77);
    expect(worstCaseCents({ scenes: 0, control: true, perImage: 11 })).toBe(44);
  });
});

describe("computeCaps (T-41-5 A13)", () => {
  const base = {
    configuredShopCap: 12,
    shopRowsToday: 0,
    scenes: 6,
    control: false,
    platformSpendNow: 0,
    configuredPlatformCap: 50_000,
    budget: 200,
    ledger: 0,
    worstCase: 165,
  };
  it("sets the per-shop cap to today's rows + 2 x scenes", () => {
    const r = computeCaps(base);
    expect(r.caps?.shopCap).toBe(12);
  });
  it("counts a shop that already has paid rows today", () => {
    const r = computeCaps({ ...base, configuredShopCap: 30, shopRowsToday: 5 });
    expect(r.caps?.shopCap).toBe(17);
  });
  it("refuses, and never raises the product cap, when rows + 2 x scenes pass it", () => {
    const r = computeCaps({ ...base, shopRowsToday: 1 });
    expect(r.caps).toBeNull();
    expect(r.refusal).toMatch(/over the configured per-shop cap 12/);
  });
  it("sets the platform cap to the live counter plus the budget left", () => {
    const r = computeCaps({ ...base, platformSpendNow: 40, ledger: 20 });
    expect(r.caps?.platformCap).toBe(40 + 180);
  });
  it("never goes above the configured platform cap, and refuses when that cannot cover the run", () => {
    expect(
      computeCaps({ ...base, platformSpendNow: 40, configuredPlatformCap: 100 }).refusal,
    ).toMatch(/cannot cover the worst case 165c/);
    expect(
      computeCaps({ ...base, platformSpendNow: 40, configuredPlatformCap: 300 }).caps?.platformCap,
    ).toBe(240);
    expect(
      computeCaps({ ...base, platformSpendNow: 40, configuredPlatformCap: 210 }).caps?.platformCap,
    ).toBe(210);
    expect(
      computeCaps({ ...base, platformSpendNow: 200, configuredPlatformCap: 300 }).caps,
    ).toBeNull();
  });
  it("treats a configured platform cap of 0 as off and uses the room", () => {
    expect(computeCaps({ ...base, configuredPlatformCap: 0 }).caps?.platformCap).toBe(200);
  });
  it("the control needs one row, not 2 x scenes", () => {
    const r = computeCaps({ ...base, scenes: 0, control: true, worstCase: 44 });
    expect(r.caps?.shopCap).toBe(1);
  });
});

describe("paidInputsRefusal (T-41-5 A12)", () => {
  it("refuses a paid path without the budget, without the since date, or without both", () => {
    expect(
      paidInputsRefusal({ paidPath: true, budgetRaw: undefined, sinceRaw: "2026-10-13T00:00:00Z" }),
    ).toMatch(/SCENE_TRIAL_BUDGET_CENTS set explicitly/);
    expect(paidInputsRefusal({ paidPath: true, budgetRaw: "200", sinceRaw: undefined })).toMatch(
      /SCENE_TRIAL_SINCE set explicitly/,
    );
    expect(paidInputsRefusal({ paidPath: true, budgetRaw: "", sinceRaw: "" })).toMatch(
      /SCENE_TRIAL_BUDGET_CENTS and SCENE_TRIAL_SINCE/,
    );
  });
  it("lets a paid path with both set, and any mock run, through", () => {
    expect(
      paidInputsRefusal({ paidPath: true, budgetRaw: "200", sinceRaw: "2026-10-13T00:00:00Z" }),
    ).toBeNull();
    expect(
      paidInputsRefusal({ paidPath: false, budgetRaw: undefined, sinceRaw: undefined }),
    ).toBeNull();
  });
});

describe("paid-path inputs ignore .env (T-41-5 round 2)", () => {
  const root = resolve(__dirname, "../../..");
  it("a .env-only budget and since date reach paidInputsRefusal as undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-env-"));
    try {
      writeFileSync(
        join(dir, ".env"),
        "SCENE_TRIAL_BUDGET_CENTS=200\nSCENE_TRIAL_SINCE=2026-10-13T00:00:00Z\n",
      );
      const script = join(dir, "probe.mts");
      writeFileSync(
        script,
        `import { explicitInputs } from ${JSON.stringify(join(root, "evals/scene_trial/inputs.ts"))};
import ${JSON.stringify(join(root, "src/env.ts"))};
console.log(JSON.stringify({ explicit: explicitInputs, afterEnv: process.env.SCENE_TRIAL_BUDGET_CENTS }));
`,
      );
      const childEnv: Record<string, string | undefined> = { ...process.env };
      delete childEnv.SCENE_TRIAL_BUDGET_CENTS;
      delete childEnv.SCENE_TRIAL_SINCE;
      delete childEnv.INVAI_SKIP_DOTENV;
      const out = execFileSync(join(root, "node_modules/.bin/tsx"), [script], {
        cwd: dir,
        env: childEnv,
        encoding: "utf8",
      });
      const got = JSON.parse(out.trim().split("\n").pop() ?? "{}");
      expect(got.afterEnv).toBe("200"); // the probe really did load the .env line
      expect(got.explicit.budgetRaw).toBeUndefined();
      expect(got.explicit.sinceRaw).toBeUndefined();
      expect(
        paidInputsRefusal({
          paidPath: true,
          budgetRaw: got.explicit.budgetRaw,
          sinceRaw: got.explicit.sinceRaw,
        }),
      ).toMatch(/SCENE_TRIAL_BUDGET_CENTS and SCENE_TRIAL_SINCE set explicitly/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("run.ts imports inputs first and never reads the two variables from process.env", () => {
    const src = readFileSync(join(root, "evals/scene_trial/run.ts"), "utf8");
    expect(src.split("\n").find((l) => l.startsWith("import "))).toMatch(/\.\/inputs"/);
    expect(src).not.toMatch(/process\.env\.SCENE_TRIAL_(BUDGET_CENTS|SINCE)\s*(\|\||[,)])/);
  });
});

describe("dayEndRefusal (23:30Z)", () => {
  it("allows a run that ends before 23:30Z and refuses one that would not", () => {
    // 12 calls x 180 s = 36 min
    expect(dayEndRefusal({ now: new Date("2026-10-13T10:00:00Z"), calls: 12 })).toBeNull();
    expect(dayEndRefusal({ now: new Date("2026-10-13T22:54:00Z"), calls: 12 })).toBeNull();
    expect(dayEndRefusal({ now: new Date("2026-10-13T22:55:00Z"), calls: 12 })).toMatch(
      /after the 23:30Z cutoff of 2026-10-13/,
    );
    expect(dayEndRefusal({ now: new Date("2026-10-13T23:40:00Z"), calls: 1 })).toMatch(/cutoff/);
  });
});

describe("promptLabelForBlank (T-41-5)", () => {
  it("prints v5 only for blanks with luma under 0.35, v4 for every other", () => {
    expect(promptLabelForBlank("#000000")).toBe("scene_prompt@5");
    expect(promptLabelForBlank("#1a1a1a")).toBe("scene_prompt@5");
    expect(promptLabelForBlank("#ffffff")).toBe("scene_prompt@4");
    expect(promptLabelForBlank("#808080")).toBe("scene_prompt@4");
    expect(promptLabelForBlank("not-a-hex")).toBe("scene_prompt@4");
  });
});

describe("--max-calls (T-43-2)", () => {
  const MAX_ENV = { paid: true, requestedOpenAi: true, yesPaid: true, providerName: "openai" };

  it("worst case is min(scenes x 2, N) calls plus the 33c margin; no N keeps every current run", () => {
    expect(worstCaseCents({ scenes: 6, control: false, perImage: 11 })).toBe(165);
    expect(worstCaseCents({ scenes: 6, control: false, perImage: 11, maxCalls: 6 })).toBe(99);
    expect(worstCaseCents({ scenes: 6, control: false, perImage: 11, maxCalls: 50 })).toBe(165);
    expect(worstCaseCents({ scenes: 0, control: true, perImage: 11, maxCalls: 3 })).toBe(44);
    expect(maxCallsFor({ scenes: 3, control: false, maxCalls: 4 })).toBe(4);
    expect(maxCallsFor({ scenes: 3, control: false })).toBe(6);
  });

  it("at budget 100 a 6-scene run is refused without N (165c) and accepted with N = 6 (99c)", () => {
    const base = { ...MAX_ENV, ledger: 0, budget: 100 };
    const without = worstCaseCents({ scenes: 6, control: false, perImage: 11 });
    expect(paidRunRefusal({ ...base, worstCase: without })).toMatch(/165c exceeds the budget 100c/);
    const withN = worstCaseCents({ scenes: 6, control: false, perImage: 11, maxCalls: 6 });
    expect(paidRunRefusal({ ...base, worstCase: withN })).toBeNull();
    expect(paidRunRefusal({ ...base, ledger: 2, worstCase: withN })).toMatch(/exceeds the budget/);
  });

  it("the 23:30Z check uses min(N, 2 x scenes) calls", () => {
    const now = new Date("2026-10-13T22:58:00Z");
    expect(
      dayEndRefusal({ now, calls: maxCallsFor({ scenes: 6, control: false }) }),
    ).not.toBeNull();
    expect(
      dayEndRefusal({ now, calls: maxCallsFor({ scenes: 6, control: false, maxCalls: 2 }) }),
    ).toBeNull();
  });

  it("parses N as a positive whole number", () => {
    expect(parseMaxCalls(null)).toBeNull();
    expect(parseMaxCalls("6")).toBe(6);
    for (const bad of ["0", "-1", "2.5", "six", ""])
      expect(() => parseMaxCalls(bad)).toThrow(/--max-calls/);
  });

  it("refuses call N+1, and a retry that would take a reserved first try", () => {
    const l = createCallLimiter({ maxCalls: 6, scenes: 6 });
    for (let i = 0; i < 6; i++) {
      l.begin();
      expect(l.take()).toBeNull();
    }
    l.begin();
    expect(l.take()).toMatch(/reached/);
    expect(l.calls).toBe(6);

    // N = 7 for 6 scenes: scene 1 may retry only while calls left exceed the waiting scenes.
    const m = createCallLimiter({ maxCalls: 7, scenes: 6 });
    m.begin();
    expect(m.take()).toBeNull();
    expect(m.take()).toBeNull(); // 6 left, 5 waiting: the retry fits
    for (let i = 0; i < 5; i++) {
      m.begin();
      expect(m.take()).toBeNull();
    }
    expect(m.calls).toBe(7);
    const k = createCallLimiter({ maxCalls: 6, scenes: 6 });
    k.begin();
    expect(k.take()).toBeNull();
    expect(k.take()).toMatch(/reserved for 5 scene/); // 5 left, 5 waiting: refused
    expect(k.calls).toBe(1);
  });

  it("a retry runs when every scene has had its first try", () => {
    const l = createCallLimiter({ maxCalls: 8, scenes: 6 });
    for (let i = 0; i < 6; i++) {
      l.begin();
      expect(l.take()).toBeNull();
    }
    expect(l.take()).toBeNull(); // last scene retries: 2 left, 0 waiting
    expect(l.take()).toBeNull();
    expect(l.take()).toMatch(/reached/);
  });

  it("wraps the object getImageProvider returns, so a caller that fetches it itself is counted", async () => {
    const shop = await createCompany();
    const l = createCallLimiter({ maxCalls: 1, scenes: 1 });
    const real = mockImageProvider.generateScene;
    const restore = limitProviderCalls(await getImageProvider(shop.id), l);
    try {
      const fetched = await getImageProvider(shop.id);
      expect(fetched).toBe(mockImageProvider);
      expect(fetched.generateScene).not.toBe(real);
      const input = { baseImage: Buffer.alloc(0), mask: Buffer.alloc(0), sizePx: 64 } as never;
      l.begin();
      vi.spyOn(mockImageProvider, "estimateCents");
      await fetched.generateScene(input).catch(() => undefined);
      expect(l.calls).toBe(1);
      const refused = await fetched.generateScene(input).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ImageGenError);
      expect((refused as ImageGenError).retryable).toBe(false);
      expect(l.calls).toBe(1);
    } finally {
      restore();
    }
    expect(mockImageProvider.generateScene).toBe(real);
  });

  it("a refusal books a 0c row (non-retryable ImageGenError), where a plain Error books the 11c estimate", async () => {
    const png = encodePng({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(255) });
    const design = { fileKey: "x/design.png", widthIn: 10, heightIn: 11 };
    const rowsFor = async (companyId: string) =>
      withTenant(companyId, (tx) =>
        tx.select().from(aiJobs).where(eq(aiJobs.companyId, companyId)),
      );
    const paidLike = (fail: Error): ImageProvider => ({
      name: "openai",
      model: "fake-paid",
      estimateCents: () => 11,
      generateScene: async () => {
        throw fail;
      },
    });
    const run = async (provider: ImageProvider) => {
      const shop = await createCompany();
      const base = `${shop.id}/photos/control/t-base.png`;
      const mask = `${shop.id}/photos/control/t-mask.png`;
      await putObject(base, png, "image/png");
      await putObject(mask, png, "image/png");
      vi.spyOn(imaging, "photoSceneBase").mockResolvedValue({
        key: base,
        mask_key: mask,
        print_box_px: [1, 1, 5, 5],
      });
      await runControl({
        companyId: shop.id,
        userId: null,
        provider,
        design,
        colorHex: "#fff",
      }).catch(() => undefined);
      return rowsFor(shop.id);
    };
    // Refused through the wrapper (limiter already used up).
    const l = createCallLimiter({ maxCalls: 1, scenes: 1 });
    l.begin();
    l.take();
    const inner = paidLike(new Error("must not be reached"));
    const wrapped: ImageProvider = { ...inner };
    limitProviderCalls(wrapped, l);
    const refusedRows = await run(wrapped);
    expect(refusedRows).toHaveLength(1);
    expect(refusedRows[0]).toMatchObject({ status: "failed", costCents: 0, provider: "openai" });
    // Contrast: a plain Error is treated as billed.
    const plainRows = await run(paidLike(new Error("refused")));
    expect(plainRows[0]?.costCents).toBe(11);
  });
});

describe("--channels (T-43-2)", () => {
  it("defaults to shopify,etsy and accepts a validated comma list", () => {
    expect(parseChannels(null)).toEqual(["shopify", "etsy"]);
    expect(parseChannels("etsy")).toEqual(["etsy"]);
    expect(parseChannels("etsy, shopify")).toEqual(["etsy", "shopify"]);
  });
  it("rejects a channel without a photo preset, an unknown one, an empty list and a repeat", () => {
    for (const bad of ["csv", "ebay", "etsyy", "", "etsy,etsy", "etsy,"])
      expect(() => parseChannels(bad)).toThrow(/--channels/);
  });
});
