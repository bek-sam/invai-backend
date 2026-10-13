import { call } from "@orpc/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withTenant } from "../../db/client";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { acceptedByName } from "./accepted-by";
import { setQaCooldown } from "./qa-turn";

/*
 * T-47-4 (B-395, S-74 residual): `acceptedBy` is cut on a whole character. A cut inside an emoji
 * left a lone surrogate, which Postgres jsonb refuses, so the accept failed. Everything goes through
 * the real router (`designs.acceptQaWarning`, then `designs.list` / `designs.get`).
 */
const img = vi.hoisted(() => ({ qaCheck: vi.fn(), isUp: vi.fn(async () => true) }));
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return { ...actual, imaging: { ...actual.imaging, qaCheck: img.qaCheck, isUp: img.isUp } };
});

import * as svc from "./service";

const N = (k: number) => "N".repeat(k);
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // 11 units
const FLAG = "\u{1F1FA}\u{1F1F8}"; // 4 units
const E_ACUTE = "é"; // 2 units
const HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

describe("acceptedBy is cut by whole characters (T-47-4)", () => {
  let companyId: string;
  let n = 0;
  let designerCtx: ReturnType<typeof tenantContext>;

  const routerCtx = (
    u: { id: string; name: string },
    role: "designer" | "admin" | "office" | "presser" | "owner",
  ) => ({
    ...anonymousContext(new Headers(), null),
    sessionKind: "user" as const,
    user: { id: u.id, name: u.name, email: "x@test.local" },
    companyId,
    orgType: "shop" as const,
    role,
    permissions: permissionsFor(role),
  });

  beforeAll(async () => {
    setQaCooldown(0);
    companyId = (await createCompany()).id;
    const d = await createUser(companyId, "designer", { name: "Base Designer" });
    designerCtx = {
      ...tenantContext(companyId, d.id, "designer"),
      user: { id: d.id, name: d.name, email: "x@test.local" },
    } as ReturnType<typeof tenantContext>;
  });
  beforeEach(() => img.qaCheck.mockReset());

  async function designWithWarning() {
    n++;
    img.qaCheck.mockResolvedValue({
      width_px: 3000,
      height_px: 3000,
      has_alpha: true,
      soft_alpha_ratio: 0,
      effective_dpi: 300,
      issues: [{ code: "white_box", severity: "warn", message: "white_box warning" }],
    });
    const created = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, designerCtx, {
        code: `AB${n}-${Math.random().toString(36).slice(2, 6)}`,
        name: `AB ${n}`,
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: `${companyId}/design/ab-${n}.png`,
            widthIn: 10,
            heightIn: 10,
          },
        ],
        personalizationTemplateId: null,
      }),
    );
    return withTenant(companyId, (tx) => svc.runDesignQa(tx, designerCtx, created.id));
  }

  /** Accept through the router as a user with this name; return acceptedBy after list and get too. */
  async function acceptAs(name: string): Promise<string | undefined> {
    const user = await createUser(companyId, "designer", { name });
    const c = { context: routerCtx({ id: user.id, name }, "designer") };
    const d = await designWithWarning();
    const ok = await call(
      router.designs.acceptQaWarning,
      { id: d.id, placement: "front", code: "white_box" },
      c,
    );
    const by = ok.placements[0]?.qa.issues[0]?.acceptedBy;
    const list = await call(router.designs.list, { limit: 200 }, c);
    expect(list.items.some((x) => x.id === d.id)).toBe(true);
    const got = await call(router.designs.get, { id: d.id }, c);
    expect(got.placements[0]?.qa.issues[0]?.acceptedBy).toBe(by);
    return by;
  }

  const whole = (by: string | undefined) => {
    expect(by).toBeDefined();
    expect((by as string).length).toBeLessThanOrEqual(200);
    expect(() => encodeURIComponent(by as string)).not.toThrow(); // throws on a lone surrogate
    expect(by).not.toMatch(HIGH_SURROGATE);
  };

  it("keeps 199 and 200 units whole and cuts 201 to 200", async () => {
    expect(await acceptAs(N(199))).toBe(N(199));
    expect(await acceptAs(N(200))).toBe(N(200));
    expect(await acceptAs(N(201))).toBe(N(200));
  });

  it("drops an emoji that straddles unit 200 whole, and keeps one that ends at 200", async () => {
    const by = await acceptAs(`${N(199)}\u{1F600}tail`);
    whole(by);
    expect(by).toBe(N(199));
    expect(await acceptAs(`${N(198)}\u{1F600}tail`)).toBe(`${N(198)}\u{1F600}`);
  });

  it("cuts a name that is all emoji on an emoji boundary", async () => {
    const by = await acceptAs("\u{1F600}".repeat(150));
    whole(by);
    expect(by).toBe("\u{1F600}".repeat(100));
  });

  it("does not split a base letter from its combining mark", async () => {
    const by = await acceptAs(`${N(199)}${E_ACUTE}`);
    whole(by);
    expect(by).toBe(N(199));
  });

  it("keeps a ZWJ family emoji whole or drops it whole", async () => {
    const by = await acceptAs(`${N(195)}${FAMILY}`);
    whole(by);
    expect(by).toBe(N(195));
    expect(await acceptAs(`${N(188)}${FAMILY}x`)).toBe(`${N(188)}${FAMILY}x`);
  });

  it("keeps a flag whole or drops it whole", async () => {
    const by = await acceptAs(`${N(198)}${FLAG}`);
    whole(by);
    expect(by).toBe(N(198));
  });

  it("falls back to a code-point cut for one grapheme over 200 units, never ending in a high surrogate", async () => {
    const one = `\u{1F600}́${"‍\u{1F600}".repeat(100)}`;
    const segs = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(one)];
    expect(segs).toHaveLength(1);
    expect(one.length).toBeGreaterThan(200);
    expect(one.slice(0, 200)).toMatch(HIGH_SURROGATE); // the naive cut would break here
    const by = await acceptAs(one);
    whole(by);
    expect(by?.length).toBe(199);
    expect(await acceptAs(`e${"́".repeat(250)}`)).toHaveLength(200);
  });

  it("falls back to A teammate for an empty or whitespace-only name", async () => {
    expect(await acceptAs("   ")).toBe("A teammate");
    expect(await acceptAs("　 \t")).toBe("A teammate");
  });

  it("trims the end after the cut", async () => {
    expect(await acceptAs(`${N(197)}   ${N(10)}`)).toBe(N(197));
  });

  it("repairs a lone surrogate in the stored name instead of passing it on", () => {
    const by = acceptedByName(`Ana\uD83D`);
    expect(() => encodeURIComponent(by)).not.toThrow();
    expect(acceptedByName(null)).toBe("A teammate");
  });
});
