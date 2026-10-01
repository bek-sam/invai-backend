import {
  ALERT_MESSAGE_CODES,
  ALERT_MESSAGE_PARAM_KEYS,
  AlertParams,
  TodaySummary,
} from "@invai/contracts";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { alerts, channelConnections, locations, orders, subscriptions } from "../../db/schema";
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

/** One representative value per `AlertParams` key, used to fill every code's params below. */
const SAMPLE_PARAM_VALUES: Required<AlertParams> = {
  orderNo: "1042",
  shipBy: new Date().toISOString(),
  timeZone: "America/Phoenix",
  hours: 5,
  connectionName: "Etsy Store",
  sheetName: "S-12",
  sheetStatus: "sent",
  blankName: "Gildan 5000 Black M",
  available: 3,
  reorderPoint: 10,
  incoming: 0,
  usedPct: 92,
  used: 920,
  limit: 1000,
  planName: "Growth",
  vendorName: "Sun City DTF",
  poNo: "PO-1",
  supplierName: "s_and_s",
  channel: "shopify",
};

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
  let connectionId: string;
  let riskyOrderId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    await createUser(companyId, "presser");
    ctx = tenantContext(companyId, owner.id, "owner");
    await createLocation(companyId);
    const conn = await createConnection(companyId);
    connectionId = conn.id;
    await createOrder(companyId, conn.id, { units: 2, state: "needs_mapping" });
    const late = await createOrder(companyId, conn.id, { units: 1, state: "ready" });
    await withSystem((tx) =>
      tx
        .update(orders)
        .set({ shipBy: new Date(Date.now() - 3_600_000), status: "in_production" })
        .where(eq(orders.id, late.order.id)),
    );
    const risky = await createOrder(companyId, conn.id, { units: 1, state: "ready" });
    riskyOrderId = risky.order.id;
    await withSystem((tx) =>
      tx
        .update(orders)
        .set({ shipBy: new Date(Date.now() + 3 * 3_600_000) })
        .where(eq(orders.id, risky.order.id)),
    );
    await withSystem((tx) =>
      tx
        .update(channelConnections)
        .set({
          status: "error",
          lastError: "401 unauthorized",
          lastErrorAt: new Date(Date.now() - 40 * 60_000),
        })
        .where(eq(channelConnections.id, conn.id)),
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

    // B-224: each kind generateAlerts raises here fills messageCode + the ruled params; the old
    // English title/message a web client without the new build still reads stays unchanged.
    expect(overdue?.messageCode).toBe("order_overdue");
    expect(overdue?.params).toEqual({
      orderNo: expect.any(String),
      shipBy: expect.any(String),
      timeZone: "America/Phoenix",
    });
    expect(overdue?.message).toBe(
      `Ship-by was ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/Phoenix" }).format(new Date(overdue?.params?.shipBy as string))} and no label has been bought.`,
    );

    const atRisk = list.items.find((a) => a.entity?.id === riskyOrderId);
    expect(atRisk?.messageCode).toBe("order_at_risk");
    expect(Object.keys(atRisk?.params ?? {}).sort()).toEqual(
      [...ALERT_MESSAGE_PARAM_KEYS.order_at_risk].sort(),
    );
    expect(atRisk?.message).toBe(`Ships within ${atRisk?.params?.hours}h and has no label yet.`);

    const broken = list.items.find(
      (a) => a.kind === "sync_broken" && a.entity?.id === connectionId,
    );
    expect(broken?.messageCode).toBe("sync_broken");
    expect(broken?.params).toEqual({ connectionName: "csv test" });
    expect(broken?.message).toBe("401 unauthorized");

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

describe("Alert.messageCode/params round trip (B-224)", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
  });

  // Every code the ruling table lists (including the ones only raised from shipping/jobs.ts,
  // inventory/jobs.ts, channels/jobs.ts and vendors/delivery.ts): raiseAlert stores messageCode +
  // params nested in `data`, and toAlert hands back exactly the keys `ALERT_MESSAGE_PARAM_KEYS`
  // says that code uses, with their values untouched.
  it.each(ALERT_MESSAGE_CODES)("code %s: params keys match the ruling", async (code) => {
    const keys = ALERT_MESSAGE_PARAM_KEYS[code];
    const params = Object.fromEntries(keys.map((k) => [k, SAMPLE_PARAM_VALUES[k]]));
    expect(AlertParams.safeParse(params).success).toBe(true);
    const { id } = await withTenant(companyId, (tx) =>
      svc.raiseAlert(tx, companyId, {
        kind: "order_at_risk",
        severity: "warning",
        title: "English fallback title",
        message: "English fallback message",
        dedupeKey: `roundtrip:${code}`,
        messageCode: code,
        params,
      }),
    );
    const list = await withTenant(companyId, (tx) => svc.listAlerts(tx, ctx, { limit: 100 }));
    const alert = list.items.find((a) => a.id === id);
    expect(alert?.messageCode).toBe(code);
    expect(alert?.params).toEqual(params);
    expect(Object.keys(alert?.params ?? {}).sort()).toEqual([...keys].sort());
    // the English fallback is always there too, unchanged by having a code.
    expect(alert?.title).toBe("English fallback title");
    expect(alert?.message).toBe("English fallback message");
  });

  it("re-raising the same dedupeKey with different params keeps them current, not duplicated", async () => {
    const first = await withTenant(companyId, (tx) =>
      svc.raiseAlert(tx, companyId, {
        kind: "stock_low",
        severity: "warning",
        title: "Low stock",
        message: "3 available",
        dedupeKey: "roundtrip:update",
        messageCode: "stock_low",
        params: { blankName: "A", available: 3, reorderPoint: 10, incoming: 0 },
      }),
    );
    expect(first.created).toBe(true);
    const second = await withTenant(companyId, (tx) =>
      svc.raiseAlert(tx, companyId, {
        kind: "stock_low",
        severity: "critical",
        title: "Out of stock",
        message: "0 available",
        dedupeKey: "roundtrip:update",
        messageCode: "stock_low",
        params: { blankName: "A", available: 0, reorderPoint: 10, incoming: 5 },
      }),
    );
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    const rows = await withSystem((tx) =>
      tx
        .select()
        .from(alerts)
        .where(and(eq(alerts.companyId, companyId), eq(alerts.dedupeKey, "roundtrip:update"))),
    );
    expect(rows).toHaveLength(1);
    const list = await withTenant(companyId, (tx) => svc.listAlerts(tx, ctx, { limit: 100 }));
    const alert = list.items.find((a) => a.id === first.id);
    expect(alert?.params).toEqual({ blankName: "A", available: 0, reorderPoint: 10, incoming: 5 });
  });

  it("an unknown code or no code at all shows only the English fallback (old rows, worker/AI alerts)", async () => {
    const [noCode] = await withSystem((tx) =>
      tx
        .insert(alerts)
        .values({
          companyId,
          kind: "artwork_flagged",
          severity: "warning",
          title: "Old-style alert",
          message: "Written before 0.11.0",
          dedupeKey: "roundtrip:old-row",
          data: {},
        })
        .returning({ id: alerts.id }),
    );
    const [unknownCode] = await withSystem((tx) =>
      tx
        .insert(alerts)
        .values({
          companyId,
          kind: "artwork_flagged",
          severity: "warning",
          title: "Future alert",
          message: "A code this build doesn't know yet",
          dedupeKey: "roundtrip:future-code",
          data: { messageCode: "order_very_late", params: {} },
        })
        .returning({ id: alerts.id }),
    );
    const list = await withTenant(companyId, (tx) => svc.listAlerts(tx, ctx, { limit: 200 }));
    for (const id of [noCode?.id, unknownCode?.id]) {
      const alert = list.items.find((a) => a.id === id);
      expect(alert?.messageCode).toBeUndefined();
      expect(alert?.params).toBeUndefined();
    }
    expect(list.items.find((a) => a.id === noCode?.id)?.title).toBe("Old-style alert");
    expect(list.items.find((a) => a.id === unknownCode?.id)?.message).toBe(
      "A code this build doesn't know yet",
    );
  });
});
