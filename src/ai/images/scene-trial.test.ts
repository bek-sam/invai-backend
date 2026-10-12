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
  ledgerCents,
  paidRunRefusal,
  parseKinds,
} from "../../../evals/scene_trial/guard";
import { withSystem, withTenant } from "../../db/client";
import { aiJobs, photoImages } from "../../db/schema";
import { env } from "../../env";
import { imaging } from "../../integrations/imaging/client";
import { getObject, putObject } from "../../lib/s3";
import { createCompany } from "../../test/fixtures";
import { type ImageProvider, mockImageProvider } from "./index";
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
