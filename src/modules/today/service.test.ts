import { TodaySummary } from "@invai/contracts";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { alerts, locations, orders, subscriptions } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { onOrganizationCreated } from "./org-hooks";
import * as svc from "./service";

describe("capacity", () => {
  it("multiplies staff × rate × hours left in the shift", () => {
    expect(
      svc.capacity({
        staff: 2,
        itemsPerHour: 12,
        hourNow: 13,
        shiftStartHour: 7,
        shiftEndHour: 17,
      }),
    ).toEqual({ hoursLeft: 4, capacityItems: 96 });
    expect(
      svc.capacity({ staff: 2, itemsPerHour: 12, hourNow: 5, shiftStartHour: 7, shiftEndHour: 17 }),
    ).toEqual({ hoursLeft: 10, capacityItems: 240 });
    expect(
      svc.capacity({
        staff: 0,
        itemsPerHour: 12,
        hourNow: 18,
        shiftStartHour: 7,
        shiftEndHour: 17,
      }),
    ).toEqual({ hoursLeft: 0, capacityItems: 0 });
  });
});

describe("today + alerts", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    await createUser(companyId, "presser");
    ctx = tenantContext(companyId, owner.id, "owner");
    await createLocation(companyId);
    const conn = await createConnection(companyId);
    await createOrder(companyId, conn.id, { units: 2, state: "needs_mapping" });
    const late = await createOrder(companyId, conn.id, { units: 1, state: "ready" });
    await withSystem((tx) =>
      tx
        .update(orders)
        .set({ shipBy: new Date(Date.now() - 3_600_000), status: "in_production" })
        .where(eq(orders.id, late.order.id)),
    );
  });

  it("summarizes the day per the contract", async () => {
    const s = await withTenant(companyId, (tx) => svc.summary(tx, ctx, {}));
    expect(() => TodaySummary.parse(s)).not.toThrow();
    expect(s.blocked.needsMapping).toBe(2);
    expect(s.orders.overdue).toBe(1);
    expect(s.stations.map((x) => x.station)).toEqual(["pick", "press", "qc", "pack"]);
  });

  it("generates alerts idempotently and resolves cleared ones", async () => {
    const first = await withTenant(companyId, (tx) => svc.generateAlerts(tx, ctx));
    expect(first.created).toBeGreaterThanOrEqual(1);
    const again = await withTenant(companyId, (tx) => svc.generateAlerts(tx, ctx));
    expect(again.created).toBe(0);
    const list = await withTenant(companyId, (tx) => svc.listAlerts(tx, ctx, { limit: 50 }));
    const overdue = list.items.find((a) => a.kind === "order_overdue");
    expect(overdue?.severity).toBe("critical");
    expect(list.unread).toBe(list.items.length);

    const marked = await withTenant(companyId, (tx) =>
      svc.markRead(tx, ctx, [overdue?.id as string]),
    );
    expect(marked.updated).toBe(1);
    const all = await withTenant(companyId, (tx) => svc.markAllRead(tx, ctx));
    expect(all.updated).toBe(list.items.length - 1);

    // The order ships: its alert resolves on the next sweep.
    await withSystem((tx) =>
      tx.update(orders).set({ status: "shipped" }).where(eq(orders.companyId, companyId)),
    );
    const third = await withTenant(companyId, (tx) => svc.generateAlerts(tx, ctx));
    expect(third.resolved).toBeGreaterThanOrEqual(1);
    const rows = await withSystem((tx) =>
      tx.select().from(alerts).where(eq(alerts.companyId, companyId)),
    );
    expect(rows.find((r) => r.kind === "order_overdue")?.status).toBe("resolved");
  });

  it("sets up a new organization with a Main location and a trial", async () => {
    const org = await createCompany();
    await onOrganizationCreated({ id: org.id, type: "shop" });
    await onOrganizationCreated({ id: org.id, type: "shop" });
    const locs = await withSystem((tx) =>
      tx.select().from(locations).where(eq(locations.companyId, org.id)),
    );
    expect(locs.map((l) => l.name)).toEqual(["Main"]);
    const subs = await withSystem((tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.companyId, org.id)),
    );
    expect(subs[0]?.status).toBe("trialing");
  });
});
