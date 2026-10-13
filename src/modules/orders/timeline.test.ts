import type { OrderItemState } from "@invai/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "../../db/client";
import { orderItemTransitions } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { cancelOrder, holdOrder, reasonCodeFor, releaseOrder, timeline } from "./service";
import { transitionItem } from "./state-machine";

/**
 * T-P5-4 (B-238): `reasonCodeFor` is the pure read-time mapping from a stored
 * `item_transitions.reason` to the contract's `TimelineReasonCode`/`TimelineReasonParams`, per
 * the rules in `invai-docs/waves/P5/reviews/plan-architect.md` R1. Table test first (lowest
 * layer), then one end-to-end check that `timeline()` actually wires it in.
 */
describe("reasonCodeFor (B-238)", () => {
  const cases: [OrderItemState | null, string | null, ReturnType<typeof reasonCodeFor>][] = [
    [null, null, {}],
    ["ready", "", {}],
    // the target state decides first: these reasons sit in both HOLD_REASONS and CANCEL_REASONS
    [
      "on_hold",
      "buyer_request",
      { reasonCode: "held", reasonParams: { holdReason: "buyer_request" } },
    ],
    [
      "cancelled",
      "buyer_request",
      { reasonCode: "cancelled", reasonParams: { cancelReason: "buyer_request" } },
    ],
    [
      "on_hold",
      "address_check",
      { reasonCode: "held", reasonParams: { holdReason: "address_check" } },
    ],
    [
      "cancelled",
      "out_of_stock",
      { reasonCode: "cancelled", reasonParams: { cancelReason: "out_of_stock" } },
    ],
    // a reason not valid for the state it's attached to carries no code
    ["ready", "address_check", {}],
    // exact strings
    ["needs_mapping", "unknown_sku", { reasonCode: "unknown_sku" }],
    ["ready", "mapped", { reasonCode: "mapped" }],
    ["ready", "not_personalized", { reasonCode: "not_personalized" }],
    ["ready", "artwork_uploaded", { reasonCode: "artwork_uploaded" }],
    ["ready", "artwork_approved", { reasonCode: "artwork_approved" }],
    ["ready", "artwork_edited", { reasonCode: "artwork_edited" }],
    ["ready", "artwork_rerendered", { reasonCode: "artwork_rerendered" }],
    ["ready", "artwork_rendered", { reasonCode: "artwork_rendered" }],
    ["needs_artwork", "artwork_failed", { reasonCode: "artwork_failed" }],
    ["needs_artwork", "artwork_flagged", { reasonCode: "artwork_flagged" }],
    ["imported", "released", { reasonCode: "released" }],
    ["ready", "qc_fail", { reasonCode: "qc_fail" }],
    ["transfer_in", "scan match", { reasonCode: "scan_match" }],
    ["ready", "QC pass", { reasonCode: "qc_pass" }],
    ["packed", "tracking pushed", { reasonCode: "tracking_pushed" }],
    ["packed", "carrier accepted the package", { reasonCode: "carrier_accepted" }],
    ["delivered", "carrier delivered", { reasonCode: "carrier_delivered" }],
    // sheet/reprint patterns
    ["on_sheet", "on sheet S-12", { reasonCode: "on_sheet", reasonParams: { sheetName: "S-12" } }],
    [
      "transfer_in",
      "sheet S-12 received",
      { reasonCode: "sheet_received", reasonParams: { sheetName: "S-12" } },
    ],
    [
      "ready",
      "reprint: misprint",
      { reasonCode: "reprint", reasonParams: { reprintReason: "misprint" } },
    ],
    // a reprint reason this build doesn't know: the code still goes out, without the param
    ["ready", "reprint: smudge", { reasonCode: "reprint" }],
    // anything else: no code, the client falls back to `message`
    ["ready", "operator note: looked fine to me", {}],
  ];

  it.each(cases)("to=%s reason=%s -> %j", (to, reason, expected) => {
    expect(reasonCodeFor(to, reason)).toEqual(expected);
  });
});

describe("orders.timeline carries reasonCode/reasonParams (read time, no producer change)", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let orderId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const office = await createUser(companyId, "office");
    ctx = tenantContext(companyId, office.id, "office");
    await createLocation(companyId);
    const conn = await createConnection(companyId);
    const { order } = await createOrder(companyId, conn.id, { units: 1, state: "ready" });
    orderId = order.id;
  });

  it("held -> released -> cancelled each show up with their reasonCode/reasonParams", async () => {
    await withTenant(companyId, (tx) =>
      holdOrder(tx, ctx, { id: orderId, reason: "address_check", note: null }),
    );
    await withTenant(companyId, (tx) => releaseOrder(tx, ctx, orderId));
    await withTenant(companyId, (tx) =>
      cancelOrder(tx, ctx, { id: orderId, reason: "buyer_request", note: null }),
    );

    const tl = await withTenant(companyId, (tx) => timeline(tx, ctx, { id: orderId, limit: 50 }));
    const stateChanges = tl.items.filter((e) => e.kind === "state_changed");

    const held = stateChanges.find((e) => e.to === "on_hold");
    expect(held?.reasonCode).toBe("held");
    expect(held?.reasonParams).toEqual({ holdReason: "address_check" });
    // the message text itself is unchanged by this card
    expect(held?.message).toBe("ready → on_hold (address_check)");

    const released = stateChanges.find((e) => e.from === "on_hold");
    expect(released?.reasonCode).toBe("released");

    const cancelled = stateChanges.find((e) => e.to === "cancelled");
    expect(cancelled?.reasonCode).toBe("cancelled");
    expect(cancelled?.reasonParams).toEqual({ cancelReason: "buyer_request" });
  });
});

describe("orders.timeline keeps steps of one transaction in order (B-418)", () => {
  it("returns three steps written in one transaction newest first, and pages through them once", async () => {
    const companyId = (await createCompany()).id;
    const office = await createUser(companyId, "office");
    const ctx = tenantContext(companyId, office.id, "office");
    await createLocation(companyId);
    const conn = await createConnection(companyId);
    const { order, items } = await createOrder(companyId, conn.id, { units: 1, state: "ready" });
    const item = items[0];
    if (!item) throw new Error("no item");
    const actor = { kind: "user" as const, userId: office.id };
    await withTenant(companyId, async (tx) => {
      await transitionItem(tx, item.id, "on_sheet", { actor });
      await transitionItem(tx, item.id, "transfer_in", { actor });
      await transitionItem(tx, item.id, "pressed", { actor });
    });
    const want = ["pressed", "transfer_in", "on_sheet"];

    const all = await withTenant(companyId, (tx) => timeline(tx, ctx, { id: order.id, limit: 50 }));
    expect(all.items.filter((e) => e.kind === "state_changed").map((e) => e.to)).toEqual(want);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await withTenant(companyId, (tx) =>
        timeline(tx, ctx, { id: order.id, limit: 1, cursor }),
      );
      for (const e of page.items) if (e.kind === "state_changed") seen.push(e.to as string);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(want);
  });
});

describe("orders.timeline orders steps inside one millisecond (B-418)", () => {
  it("sorts and pages on microseconds, not milliseconds", async () => {
    const companyId = (await createCompany()).id;
    const office = await createUser(companyId, "office");
    const ctx = tenantContext(companyId, office.id, "office");
    await createLocation(companyId);
    const conn = await createConnection(companyId);
    const { order, items } = await createOrder(companyId, conn.id, { units: 1, state: "ready" });
    const item = items[0];
    if (!item) throw new Error("no item");
    // Same millisecond, microseconds apart. The ids run opposite to time, so a millisecond sort
    // (id tiebreak) would return oldest first.
    const steps = [
      { id: "00000000-0000-4000-8000-000000000001", us: "123300", to: "pressed" },
      { id: "00000000-0000-4000-8000-000000000002", us: "123200", to: "transfer_in" },
      { id: "00000000-0000-4000-8000-000000000003", us: "123100", to: "on_sheet" },
    ] as const;
    await withTenant(companyId, async (tx) => {
      for (const s of steps) {
        await tx.insert(orderItemTransitions).values({
          id: s.id,
          companyId,
          orderItemId: item.id,
          orderId: order.id,
          fromState: "ready",
          toState: s.to,
          actorKind: "system",
          createdAt: sql`${`2030-01-01T00:00:00.${s.us}Z`}::timestamptz`,
        });
      }
    });
    const want = steps.map((s) => s.to as string);
    const isStep = (e: { id: string }) => steps.some((s) => s.id === e.id);

    const all = await withTenant(companyId, (tx) => timeline(tx, ctx, { id: order.id, limit: 50 }));
    expect(all.items.filter(isStep).map((e) => e.to)).toEqual(want);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await withTenant(companyId, (tx) =>
        timeline(tx, ctx, { id: order.id, limit: 1, cursor }),
      );
      for (const e of page.items) if (isStep(e)) seen.push(e.to as string);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(want);
  });
});
