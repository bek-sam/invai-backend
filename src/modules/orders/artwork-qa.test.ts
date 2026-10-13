import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { orderItems } from "../../db/schema";
import { redis } from "../../lib/queues";
import { createCompany, createConnection, createOrder, tenantContext } from "../../test/fixtures";
import { type QaStub, startQaStub } from "../catalog/qa-stub.testutil";
import { setQaCooldown, takeQaTurn } from "../catalog/qa-turn";
import { itemArtworkQaJob } from "./jobs";
import { setItemArtwork } from "./service";

/*
 * T-43-3 (B-399): setItemArtwork never drops its QA silently. Imaging is an in-process stub.
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
    },
  };
});

import { imaging } from "../../integrations/imaging/client";

let stub: QaStub;
let companyId: string;
let otherId: string;
const enqueue = vi.spyOn(itemArtworkQaJob, "enqueue");

beforeAll(async () => {
  setQaCooldown(0); // S-81: these tests take several turns in a row
  stub = await startQaStub();
  where.url = stub.url;
  stub.delayMs = 5;
  stub.issues = [
    {
      when: "lowdpi",
      list: [{ code: "low_dpi", severity: "warn", message: "Only 90 dpi at this size" }],
    },
  ];
  enqueue.mockResolvedValue(undefined as never);
  companyId = (await createCompany()).id;
  otherId = (await createCompany()).id;
});
afterAll(async () => {
  enqueue.mockRestore();
  await stub.close();
});

async function newItem(cid = companyId) {
  const conn = await createConnection(cid);
  const { items } = await createOrder(cid, conn.id);
  return items[0]?.id as string;
}
const attach = (id: string, name: string, cid = companyId) =>
  withTenant(cid, (tx) =>
    setItemArtwork(tx, tenantContext(cid, null, "office"), {
      id,
      fileKey: `${cid}/art/${name}.png`,
    }),
  );
const row = async (id: string, cid = companyId) =>
  withTenant(
    cid,
    async (tx) => (await tx.select().from(orderItems).where(eq(orderItems.id, id)))[0],
  );
const codes = async (id: string) => (await row(id))?.flags.map((f) => f.code) ?? [];
const run = (id: string, name: string, cid = companyId) =>
  itemArtworkQaJob.handler({ companyId: cid, itemId: id, fileKey: `${cid}/art/${name}.png` }, {
    timestamp: Date.now(),
    token: "t",
    moveToDelayed: vi.fn(),
  } as never);

describe("setItemArtwork follow-up QA (T-43-3 criterion 4)", () => {
  // Every QA path spends the company's allowance (3 burst); each case starts with a full one.
  beforeEach(async () => {
    await redis.del(
      `qa:rate:artwork:${companyId}`,
      `qa:rate:design:${companyId}`,
      `qa:lease:${companyId}`,
    );
  });

  it("answers at once when imaging is free: flags now, no follow-up job", async () => {
    enqueue.mockClear();
    const id = await newItem();
    await attach(id, "lowdpi-a");
    expect(await codes(id)).toEqual(["artwork_low_dpi"]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("busy: attaches the artwork, queues a follow-up, and the job applies the flags (run twice = once)", async () => {
    enqueue.mockClear();
    const id = await newItem();
    stub.hold(600);
    await attach(id, "lowdpi-b");
    expect((await row(id))?.artworkKey).toBe(`${companyId}/art/lowdpi-b.png`);
    expect(await codes(id)).toEqual([]);
    expect(enqueue).toHaveBeenCalledWith({
      companyId,
      itemId: id,
      fileKey: `${companyId}/art/lowdpi-b.png`,
    });
    await new Promise((r) => setTimeout(r, 700));
    await run(id, "lowdpi-b");
    await run(id, "lowdpi-b");
    expect(await codes(id)).toEqual(["artwork_low_dpi"]);
  });

  it("a held company lease defers too, and imaging down defers", async () => {
    enqueue.mockClear();
    const id = await newItem();
    const held = await takeQaTurn(companyId, 1, "artwork");
    await attach(id, "lowdpi-c");
    expect(enqueue).toHaveBeenCalledTimes(1);
    if (held.ok) await held.release();
    const id2 = await newItem();
    vi.spyOn(imaging, "isUp").mockResolvedValueOnce(false);
    await attach(id2, "lowdpi-d");
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("a changed artwork key: the old follow-up does nothing", async () => {
    enqueue.mockClear();
    const id = await newItem();
    stub.hold(300);
    await attach(id, "lowdpi-old"); // deferred
    await new Promise((r) => setTimeout(r, 400));
    await attach(id, "clean-new"); // checked at once, no issues
    expect(await run(id, "lowdpi-old")).toEqual({ skipped: true });
    expect(await codes(id)).toEqual([]);
  });

  it("an item that is no longer artwork-editable (on_sheet) is left alone", async () => {
    const id = await newItem();
    stub.hold(300);
    await attach(id, "lowdpi-e");
    await withSystem((tx) =>
      tx.update(orderItems).set({ state: "on_sheet" }).where(eq(orderItems.id, id)),
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(await run(id, "lowdpi-e")).toEqual({ skipped: true });
    expect(await codes(id)).toEqual([]);
  });

  it("tenant isolation: another company's job input cannot touch this item", async () => {
    const id = await newItem();
    stub.hold(300);
    await attach(id, "lowdpi-f");
    await new Promise((r) => setTimeout(r, 400));
    expect(await run(id, "lowdpi-f", otherId)).toEqual({ skipped: true });
    expect(await codes(id)).toEqual([]);
  });
});
