import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../db/client";
import { auditLog, orderItemTransitions, orders, outboxEvents } from "../../db/schema";
import { createCompany, createConnection, createOrder, createUser } from "../../test/fixtures";
import { transitionItem } from "./state-machine";

describe("orders state machine", () => {
  let companyId: string;
  let userId: string;
  let connectionId: string;

  beforeAll(async () => {
    const company = await createCompany();
    companyId = company.id;
    userId = (await createUser(companyId, "office")).id;
    connectionId = (await createConnection(companyId)).id;
  });

  const actor = () => ({ kind: "user" as const, userId });

  it("walks an item through the happy path and records everything", async () => {
    const { order, items } = await createOrder(companyId, connectionId);
    const item = items[0];
    if (!item) throw new Error("no item");

    const result = await withTenant(companyId, async (tx) => {
      await transitionItem(tx, item.id, "ready", { actor: actor() });
      await transitionItem(tx, item.id, "on_sheet", { actor: actor() });
      await transitionItem(tx, item.id, "transfer_in", { actor: actor() });
      await transitionItem(tx, item.id, "pressed", { actor: actor(), stationKind: "press" });
      return transitionItem(tx, item.id, "packed", { actor: actor(), stationKind: "pack" });
    });
    expect(result.state).toBe("packed");

    await withTenant(companyId, async (tx) => {
      const transitions = await tx
        .select()
        .from(orderItemTransitions)
        .where(eq(orderItemTransitions.orderItemId, item.id));
      expect(transitions.map((t) => t.toState)).toEqual([
        "ready",
        "on_sheet",
        "transfer_in",
        "pressed",
        "packed",
      ]);
      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, item.id));
      expect(audits).toHaveLength(5);
      const events = await tx
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.companyId, companyId));
      const names = events.map((e) => e.name);
      expect(names.filter((n) => n === "item.state_changed")).toHaveLength(5);
      expect(names).toContain("item.ready");
      expect(names).toContain("item.packed");
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o?.status).toBe("ready_to_ship");
    });
  });

  it("rejects transitions that are not in ITEM_TRANSITIONS", async () => {
    const { items } = await createOrder(companyId, connectionId);
    const item = items[0];
    if (!item) throw new Error("no item");
    await expect(
      withTenant(companyId, (tx) => transitionItem(tx, item.id, "pressed", { actor: actor() })),
    ).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      data: { from: "imported", to: "pressed" },
    });
  });

  it("holds and releases back to the held-from state", async () => {
    const { order, items } = await createOrder(companyId, connectionId, { state: "ready" });
    const item = items[0];
    if (!item) throw new Error("no item");
    const held = await withTenant(companyId, (tx) =>
      transitionItem(tx, item.id, "on_hold", { actor: actor(), reason: "buyer_request" }),
    );
    expect(held.heldFromState).toBe("ready");
    await withTenant(companyId, async (tx) => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o?.status).toBe("on_hold");
    });
    await expect(
      withTenant(companyId, (tx) => transitionItem(tx, item.id, "packed", { actor: actor() })),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const released = await withTenant(companyId, (tx) =>
      transitionItem(tx, item.id, "ready", { actor: actor() }),
    );
    expect(released.state).toBe("ready");
    expect(released.heldFromState).toBeNull();
  });

  it("derives the order status from all items", async () => {
    const { order, items } = await createOrder(companyId, connectionId, {
      units: 2,
      state: "packed",
    });
    const [a, b] = items;
    if (!a || !b) throw new Error("no items");
    await withTenant(companyId, (tx) => transitionItem(tx, a.id, "shipped", { actor: actor() }));
    await withTenant(companyId, async (tx) => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o?.status).toBe("partially_shipped");
    });
    await withTenant(companyId, (tx) => transitionItem(tx, b.id, "shipped", { actor: actor() }));
    await withTenant(companyId, async (tx) => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(o?.status).toBe("shipped");
      expect(o?.shippedAt).not.toBeNull();
    });
  });

  it("rolls back the transition row when the transaction fails", async () => {
    const { items } = await createOrder(companyId, connectionId);
    const item = items[0];
    if (!item) throw new Error("no item");
    await expect(
      withTenant(companyId, async (tx) => {
        await transitionItem(tx, item.id, "ready", { actor: actor() });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await withTenant(companyId, async (tx) => {
      const rows = await tx
        .select()
        .from(orderItemTransitions)
        .where(eq(orderItemTransitions.orderItemId, item.id));
      expect(rows).toHaveLength(0);
    });
  });
});
