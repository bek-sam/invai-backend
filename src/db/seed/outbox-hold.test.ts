import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { emit } from "../../lib/outbox";
import { createCompany } from "../../test/fixtures";
import { relayOnce } from "../../worker/outbox-relay";
import { withSystem, withTenant } from "../client";
import { outboxEvents } from "../schema";
import { HELD_MARKER, holdOutbox, releaseOutbox } from "./outbox-hold";

/*
 * T-20-5 (B-106): the seed builder parks the outbox events of each phase so a running worker's
 * relay can't dispatch them for a half-built company, then releases them all at the end.
 */

let companyId: string;
let otherId: string;

const pending = (id: string) =>
  withSystem((tx) =>
    tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.companyId, id), isNull(outboxEvents.dispatchedAt))),
  );

/**
 * The relay takes the 100 oldest pending rows per call, and other test files leave their own
 * pending rows behind in the shared test DB, so one call rarely reaches ours. Walk it until
 * `done` holds or a call finds nothing left.
 */
async function relayUntil(done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await done()) return;
    if ((await relayOnce()) === 0) return;
  }
}
const relayAll = () => relayUntil(async () => false);

beforeAll(async () => {
  companyId = (await createCompany()).id;
  otherId = (await createCompany()).id;
});

describe("holdOutbox / releaseOutbox", () => {
  it("held events are invisible to the relay until released, then dispatch in order", async () => {
    await withSystem(async (tx) => {
      await emit(tx, companyId, "order.note", { orderId: crypto.randomUUID(), note: "a" });
      await emit(tx, companyId, "order.note", { orderId: crypto.randomUUID(), note: "b" });
      expect(await holdOutbox(tx, companyId)).toBe(2);
    });
    expect(await pending(companyId)).toHaveLength(0);
    // The relay walks every pending row; ours must not be among them.
    await relayAll();
    const held = await withSystem((tx) =>
      tx
        .select({ lastError: outboxEvents.lastError, attempts: outboxEvents.attempts })
        .from(outboxEvents)
        .where(eq(outboxEvents.companyId, companyId)),
    );
    expect(held).toHaveLength(2);
    for (const h of held) {
      expect(h.lastError).toBe(HELD_MARKER);
      expect(h.attempts).toBe(0);
    }

    expect(await withSystem((tx) => releaseOutbox(tx, companyId))).toBe(2);
    expect(await pending(companyId)).toHaveLength(2);
    await relayUntil(async () => (await pending(companyId)).length === 0);
    const after = await withSystem((tx) =>
      tx
        .select({ lastError: outboxEvents.lastError, attempts: outboxEvents.attempts })
        .from(outboxEvents)
        .where(and(eq(outboxEvents.companyId, companyId), isNull(outboxEvents.dispatchedAt))),
    );
    expect(after).toHaveLength(0);
    const dispatched = await withSystem((tx) =>
      tx
        .select({ attempts: outboxEvents.attempts })
        .from(outboxEvents)
        .where(eq(outboxEvents.companyId, companyId)),
    );
    expect(dispatched.map((d) => d.attempts)).toEqual([1, 1]);
  });

  it("only touches the given company and only rows it held", async () => {
    await withSystem(async (tx) => {
      await emit(tx, otherId, "order.note", { orderId: crypto.randomUUID(), note: "x" });
      // A row the relay already parked for good must not be released as if it were held.
      await tx
        .update(outboxEvents)
        .set({ dispatchedAt: new Date(), lastError: "boom", attempts: 10 })
        .where(eq(outboxEvents.companyId, otherId));
    });
    expect(await withSystem((tx) => holdOutbox(tx, companyId))).toBe(0);
    expect(await withSystem((tx) => releaseOutbox(tx, otherId))).toBe(0);
    expect(await pending(otherId)).toHaveLength(0);
  });

  it("works under the tenant connection (the demo path runs as invai_app)", async () => {
    await withTenant(companyId, async (tx) => {
      await emit(tx, companyId, "order.note", { orderId: crypto.randomUUID(), note: "c" });
      expect(await holdOutbox(tx, companyId)).toBe(1);
    });
    expect(await pending(companyId)).toHaveLength(0);
    expect(await withTenant(companyId, (tx) => releaseOutbox(tx, companyId))).toBe(1);
    expect(await pending(companyId)).toHaveLength(1);
    await relayUntil(async () => (await pending(companyId)).length === 0);
    expect(await pending(companyId)).toHaveLength(0);
  });
});
