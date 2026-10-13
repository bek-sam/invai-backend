import { call } from "@orpc/server";
import { DelayedError } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import { orderItems } from "../../db/schema";
import { redis } from "../../lib/queues";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { itemArtworkQaJob } from "../orders/jobs";
import { type QaStub, startQaStub } from "./qa-stub.testutil";
import { QA_BURST, takeQaTurn } from "./qa-turn";
import * as svc from "./service";

/*
 * T-43-3 round 3 (architect ruling): two allowances per company. A shop's artwork follow-ups
 * can't spend its design-check allowance. Imaging is an in-process stub; Valkey is DB 14.
 */
const where = vi.hoisted(() => ({ url: "" }));
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  let c: ReturnType<typeof actual.createImagingClient> | undefined;
  const get = () => {
    c ??= actual.createImagingClient(where.url);
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
beforeAll(async () => {
  stub = await startQaStub();
  where.url = stub.url;
  stub.delayMs = 5;
});
afterAll(async () => {
  await stub.close();
});

const turn = async (id: string, bucket: "design" | "artwork") => {
  const t = await takeQaTurn(id, 1, bucket);
  if (t.ok) await t.release();
  return t;
};
const drain = async (id: string, bucket: "design" | "artwork") => {
  for (let i = 0; i < 20; i++) if (!(await turn(id, bucket)).ok) return i;
  throw new Error("never refused");
};

describe("two allowances per company", () => {
  it("artwork alone refuses after its burst, and the design bucket is untouched", async () => {
    const c = (await createCompany()).id;
    expect(await drain(c, "artwork")).toBe(QA_BURST);
    expect(await turn(c, "artwork")).toMatchObject({ ok: false, reason: "rate" });
    for (let i = 0; i < QA_BURST; i++) expect((await turn(c, "design")).ok).toBe(true);
    expect(await turn(c, "design")).toMatchObject({ ok: false, reason: "rate" });
  });

  it("draining one company's buckets leaves another company's untouched", async () => {
    const a = (await createCompany()).id;
    const b = (await createCompany()).id;
    await drain(a, "artwork");
    await drain(a, "design");
    for (const bucket of ["artwork", "design"] as const)
      for (let i = 0; i < QA_BURST; i++) expect((await turn(b, bucket)).ok).toBe(true);
  });

  it("(b) an empty artwork bucket does not cost three design turns in a row", async () => {
    const c = (await createCompany()).id;
    await drain(c, "artwork");
    expect(await turn(c, "artwork")).toMatchObject({ ok: false, reason: "rate" });
    for (let i = 0; i < 3; i++) expect((await turn(c, "design")).ok).toBe(true);
  });

  it("(b) five follow-up jobs inline, then designs.runQa still returns a result", async () => {
    const co = (await createCompany()).id;
    const userId = (await createUser(co, "owner")).id;
    const conn = await createConnection(co);
    const files: { id: string; fileKey: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const { items } = await createOrder(co, conn.id);
      const id = items[0]?.id as string;
      const fileKey = `${co}/art/bucket-${i}.png`;
      await withSystem((tx) =>
        tx.update(orderItems).set({ artworkKey: fileKey }).where(eq(orderItems.id, id)),
      );
      files.push({ id, fileKey });
    }
    const before = stub.calls["/qa/check"] ?? 0;
    let delayed = 0;
    for (const f of files) {
      const job = { timestamp: Date.now(), token: "t", moveToDelayed: vi.fn() } as never;
      try {
        await itemArtworkQaJob.handler({ companyId: co, itemId: f.id, fileKey: f.fileKey }, job);
      } catch (e) {
        if (e instanceof DelayedError) delayed++;
        else throw e;
      }
    }
    expect(stub.calls["/qa/check"] ?? 0).toBe(before + QA_BURST); // 3 served, 2 re-delayed
    expect(delayed).toBe(5 - QA_BURST);

    const d = await withTenant(co, (tx) =>
      svc.createDesign(tx, tenantContext(co, userId, "owner"), {
        code: `QB-${Math.random().toString(36).slice(2, 7)}`,
        name: "QB",
        tags: [],
        placements: [
          { placement: "front", fileKey: `${co}/design/qb.png`, widthIn: 10, heightIn: 10 },
        ],
        personalizationTemplateId: null,
      }),
    );
    const ctx = {
      ...anonymousContext(new Headers(), null),
      sessionKind: "user" as const,
      user: { id: userId, name: "T", email: "x@test.local" },
      companyId: co,
      orgType: "shop" as const,
      role: "owner" as const,
      permissions: permissionsFor("owner"),
    };
    await expect(call(router.designs.runQa, { id: d.id }, { context: ctx })).resolves.toMatchObject(
      { id: d.id },
    );
  });

  it("keys are per bucket and hold only the company id", async () => {
    const c = (await createCompany()).id;
    await turn(c, "design");
    await turn(c, "artwork");
    expect(await redis.exists(`qa:rate:design:${c}`)).toBe(1);
    expect(await redis.exists(`qa:rate:artwork:${c}`)).toBe(1);
  });
});
