import { call } from "@orpc/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withTenant } from "../../db/client";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { type QaStub, startQaStub } from "./qa-stub.testutil";
import { setQaSleep } from "./qa-turn";
import * as svc from "./service";

/*
 * T-43-3 round 2. The imaging client's sleep is replaced by one that advances a faked `Date`, so
 * a 25 s busy-wait costs no wall time: the tests count the seconds the manual call "waited".
 */
const where = vi.hoisted(() => ({ url: "", sleeps: [] as number[] }));
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  let c: ReturnType<typeof actual.createImagingClient> | undefined;
  const get = () => {
    c ??= actual.createImagingClient(where.url, undefined, undefined, async (ms) => {
      where.sleeps.push(ms);
      vi.setSystemTime(Date.now() + ms);
    });
    return c;
  };
  return {
    ...actual,
    imaging: {
      ...actual.imaging,
      isUp: () => get().isUp(),
      qaCheck: (...a: Parameters<typeof actual.imaging.qaCheck>) => get().qaCheck(...a),
      cleanAlpha: (...a: Parameters<typeof actual.imaging.cleanAlpha>) => get().cleanAlpha(...a),
    },
  };
});

let stub: QaStub;
let n = 0;
beforeAll(async () => {
  stub = await startQaStub();
  where.url = stub.url;
  stub.delayMs = 5;
  // T-46-3: a manual caller's busy sleeps happen in qa-turn now, so fake them the same way
  setQaSleep(async (ms) => {
    where.sleeps.push(ms);
    vi.setSystemTime(Date.now() + ms);
  });
});
afterAll(async () => {
  setQaSleep();
  await stub.close();
});
afterEach(() => {
  vi.useRealTimers();
  where.sleeps.length = 0;
  stub.script = [];
});

async function shopWithDesign(placements: ("front" | "back")[]) {
  const id = (await createCompany()).id;
  const userId = (await createUser(id, "designer")).id;
  n++;
  const design = await withTenant(id, (tx) =>
    svc.createDesign(tx, tenantContext(id, userId, "designer"), {
      code: `R2${n}-${Math.random().toString(36).slice(2, 6)}`,
      name: `R2 ${n}`,
      tags: [],
      placements: placements.map((p) => ({
        placement: p,
        fileKey: `${id}/design/r2-${n}-${p}.png`,
        widthIn: 10,
        heightIn: 10,
      })),
      personalizationTemplateId: null,
    }),
  );
  const context = {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user" as const,
    user: { id: userId, name: "Tester", email: "x@test.local" },
    companyId: id,
    orgType: "shop" as const,
    role: "owner" as const,
    permissions: permissionsFor("owner"),
  };
  return { id, design, context };
}

describe("A12: one busy-wait budget per manual QA, across all placements", () => {
  it("a 2-placement design waits at most 25 s in total, then answers RATE_LIMITED", async () => {
    stub.retryAfterSec = 6;
    const s = await shopWithDesign(["front", "back"]);
    // Placement 1: busy for 3 sleeps (18 s), then served. Placement 2: busy again.
    stub.script = [true, true, true, false, true, true, true, true, true];
    vi.useFakeTimers({ toFake: ["Date"] });
    const err = await call(router.designs.runQa, { id: s.design.id }, { context: s.context }).then(
      () => null,
      (e) => e as { code?: string; data?: { retryAfterSec?: number } },
    );
    const waited = where.sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeLessThanOrEqual(25_000);
    expect(err?.code).toBe("RATE_LIMITED");
  });
});

describe("A10: an imaging 429 reaches the caller as RATE_LIMITED {retryAfterSec}", () => {
  it("a single placement, imaging busy through the whole budget", async () => {
    stub.retryAfterSec = 4;
    const s = await shopWithDesign(["front"]);
    stub.script = Array(10).fill(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    const err = await call(router.designs.runQa, { id: s.design.id }, { context: s.context }).then(
      () => null,
      (e) => e as { code?: string; data?: { retryAfterSec?: number } },
    );
    expect(err?.code).toBe("RATE_LIMITED");
    expect(err?.data?.retryAfterSec).toBe(4);
  });
});
