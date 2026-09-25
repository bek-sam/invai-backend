import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import type { Role } from "../../db/schema";
import { auditLog, bins, floorRequests, orderItems, orders, scans } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import {
  orderStatusWithOverride,
  recomputeOrderStatus,
  transitionItem,
} from "../orders/state-machine";
import * as svc from "./service";

/*
 * T-4-1: production.packOrder (decision 0002 + the hand-to-lead override), the lead marker on
 * order status, the receiving station, bin double taps and who may mark sheets received.
 */

type ItemState = (typeof orderItems.$inferSelect)["state"];
type Ctx = ReturnType<typeof tenantContext>;

let n = 0;
const key = () => `pack-key-${Date.now()}-${n++}`;

async function codeOf(fn: () => Promise<unknown>) {
  try {
    await fn();
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe("production.packOrder", () => {
  let companyId: string;
  let connectionId: string;
  let packer: Ctx;
  let admin: Ctx;

  /** An order whose units are in `states`, with the stored status recomputed. */
  async function orderWith(states: ItemState[]) {
    const { order, items } = await createOrder(companyId, connectionId, {
      units: states.length,
      state: "packed",
    });
    await withSystem(async (tx) => {
      for (const [i, s] of states.entries())
        await tx
          .update(orderItems)
          .set({ state: s })
          .where(eq(orderItems.id, items[i]?.id ?? ""));
    });
    await withTenant(companyId, (tx) => recomputeOrderStatus(tx, companyId, order.id));
    return { order, ids: items.map((i) => i.id) };
  }
  const orderRow = (id: string) =>
    withTenant(
      companyId,
      async (tx) => (await tx.select().from(orders).where(eq(orders.id, id)))[0],
    );
  const count = async (
    table: typeof scans | typeof floorRequests | typeof auditLog,
    where: ReturnType<typeof eq>,
  ) =>
    withTenant(
      companyId,
      async (tx) =>
        (
          await tx
            .select()
            .from(table as typeof scans)
            .where(where)
        ).length,
    );

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    connectionId = (await createConnection(companyId)).id;
    packer = tenantContext(companyId, (await createUser(companyId, "packer")).id, "packer");
    admin = tenantContext(companyId, (await createUser(companyId, "admin")).id, "admin");
  });

  it("packs a complete order, releases its tote, and replays the stored result", async () => {
    const { order, ids } = await orderWith(["packed", "packed", "cancelled"]);
    await withTenant(companyId, (tx) =>
      svc.assignBin(tx, packer, { code: `BIN:T-${order.id.slice(0, 6)}`, orderId: order.id }),
    );
    const k = key();
    const first = await withTenant(companyId, (tx) =>
      svc.packOrder(tx, packer, { orderId: order.id, idempotencyKey: k }),
    );
    expect(first).toEqual({ orderId: order.id, packed: true, missing: [], override: null });
    expect((await orderRow(order.id))?.status).toBe("ready_to_ship");
    const tote = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(bins)
        .where(eq(bins.code, `T-${order.id.slice(0, 6)}`)),
    );
    expect(tote[0]?.orderId).toBeNull();
    // Each packed unit got a pack scan (the cancelled one didn't), so the order leaves the pack queue.
    const packScans = () =>
      withTenant(companyId, (tx) =>
        tx
          .select()
          .from(scans)
          .where(and(eq(scans.action, "pack"), eq(scans.orderItemId, ids[0] ?? ""))),
      );
    expect(await packScans()).toHaveLength(1);
    const queue = await withTenant(companyId, (tx) =>
      svc.stationQueue(tx, packer, { station: "pack", orderId: order.id, limit: 50 }),
    );
    expect(queue.items).toHaveLength(0);

    const again = await withTenant(companyId, (tx) =>
      svc.packOrder(tx, packer, { orderId: order.id, idempotencyKey: k }),
    );
    expect(again).toEqual(first);
    expect(await packScans()).toHaveLength(1);
    expect(await count(floorRequests, eq(floorRequests.idempotencyKey, k))).toBe(1);
    const packedAudits = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "order.packed"), eq(auditLog.entityId, order.id))),
    );
    expect(packedAudits).toHaveLength(1);
  });

  it("refuses a partial order with the missing units, then packs it once they're packed", async () => {
    const { order, ids } = await orderWith(["packed", "pressed", "transfer_in"]);
    const k = key();
    const refused = await withTenant(companyId, (tx) =>
      svc.packOrder(tx, packer, { orderId: order.id, idempotencyKey: k }),
    ).catch((e) => e);
    expect(refused.code).toBe("PACK_INCOMPLETE");
    expect(refused.status).toBe(409);
    expect(refused.data.missing).toEqual([
      { orderItemId: ids[1], state: "pressed" },
      { orderItemId: ids[2], state: "transfer_in" },
    ]);
    // A refusal has no effect: nothing stored, no scans, status unchanged.
    expect(await count(floorRequests, eq(floorRequests.orderId, order.id))).toBe(0);
    expect(await count(scans, eq(scans.orderItemId, ids[0] ?? ""))).toBe(0);
    expect((await orderRow(order.id))?.status).toBe("in_production");

    await withTenant(companyId, async (tx) => {
      await transitionItem(tx, ids[1] ?? "", "packed", { actor: admin.actor });
      await transitionItem(tx, ids[2] ?? "", "pressed", { actor: admin.actor });
      await transitionItem(tx, ids[2] ?? "", "packed", { actor: admin.actor });
    });
    // The refused key isn't burned: the same retry now succeeds (safe for an order with no tote).
    const ok = await withTenant(companyId, (tx) =>
      svc.packOrder(tx, packer, { orderId: order.id, idempotencyKey: k }),
    );
    expect(ok).toMatchObject({ packed: true, missing: [], override: null });
  });

  it("override hands a short order to a lead: admin only, audited, tote released, not packed", async () => {
    const { order, ids } = await orderWith(["packed", "packed", "transfer_in"]);
    await withTenant(companyId, (tx) =>
      svc.assignBin(tx, admin, { code: `BIN:L-${order.id.slice(0, 6)}`, orderId: order.id }),
    );
    const input = {
      orderId: order.id,
      idempotencyKey: key(),
      override: { reason: "Lost transfer" },
    };
    expect(
      await codeOf(() => withTenant(companyId, (tx) => svc.packOrder(tx, packer, input))),
    ).toBe("FORBIDDEN");
    expect((await orderRow(order.id))?.packOverride).toBeNull();

    const res = await withTenant(companyId, (tx) => svc.packOrder(tx, admin, input));
    expect(res.packed).toBe(false);
    expect(res.missing).toEqual([{ orderItemId: ids[2], state: "transfer_in" }]);
    expect(res.override).toMatchObject({
      reason: "Lost transfer",
      by: admin.userId,
      missingItemIds: [ids[2]],
    });
    const row = await orderRow(order.id);
    // Not shippable: a split shipment isn't supported, so the status stays what the units say.
    expect(row?.status).toBe("in_production");
    expect(row?.packOverride).toEqual(res.override);
    const tote = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(bins)
        .where(eq(bins.code, `L-${order.id.slice(0, 6)}`)),
    );
    expect(tote[0]?.orderId).toBeNull();
    // No pack scans: nothing was packed out.
    expect(await count(scans, eq(scans.orderItemId, ids[0] ?? ""))).toBe(0);
    const audits = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "order.pack_override"), eq(auditLog.entityId, order.id))),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(admin.userId);
    expect(audits[0]?.data).toMatchObject({ reason: "Lost transfer" });

    // A replay returns the same override; the same key with another reason is a conflict.
    expect(await withTenant(companyId, (tx) => svc.packOrder(tx, admin, input))).toEqual(res);
    expect(
      await codeOf(() =>
        withTenant(companyId, (tx) =>
          svc.packOrder(tx, admin, { ...input, override: { reason: "Other" } }),
        ),
      ),
    ).toBe("CONFLICT");

    // The next item move keeps the lead marker...
    await withTenant(companyId, (tx) =>
      transitionItem(tx, ids[2] ?? "", "pressed", { actor: admin.actor }),
    );
    expect((await orderRow(order.id))?.status).toBe("in_production");
    expect((await orderRow(order.id))?.packOverride).not.toBeNull();
    // ...and it clears itself once the missing unit is genuinely packed.
    await withTenant(companyId, (tx) =>
      transitionItem(tx, ids[2] ?? "", "packed", { actor: admin.actor }),
    );
    const done = await orderRow(order.id);
    expect(done?.status).toBe("ready_to_ship");
    expect(done?.packOverride).toBeNull();
    // Then the normal pack goes through with a new key.
    const packed = await withTenant(companyId, (tx) =>
      svc.packOrder(tx, packer, { orderId: order.id, idempotencyKey: key() }),
    );
    expect(packed).toMatchObject({ packed: true, missing: [], override: null });
  });

  it("an override is ignored when nothing is missing", async () => {
    const { order } = await orderWith(["packed"]);
    const res = await withTenant(companyId, (tx) =>
      svc.packOrder(tx, admin, {
        orderId: order.id,
        idempotencyKey: key(),
        override: { reason: "just in case" },
      }),
    );
    expect(res).toMatchObject({ packed: true, missing: [], override: null });
    expect((await orderRow(order.id))?.packOverride).toBeNull();
  });

  it("the same key on another order is a conflict", async () => {
    const a = await orderWith(["packed"]);
    const b = await orderWith(["packed"]);
    const k = key();
    await withTenant(companyId, (tx) =>
      svc.packOrder(tx, packer, { orderId: a.order.id, idempotencyKey: k }),
    );
    expect(
      await codeOf(() =>
        withTenant(companyId, (tx) =>
          svc.packOrder(tx, packer, { orderId: b.order.id, idempotencyKey: k }),
        ),
      ),
    ).toBe("CONFLICT");
    expect(await count(floorRequests, eq(floorRequests.orderId, b.order.id))).toBe(0);
  });

  it("refuses held and fully cancelled orders", async () => {
    const held = await orderWith(["packed", "on_hold"]);
    expect((await orderRow(held.order.id))?.status).toBe("on_hold");
    const input = { orderId: held.order.id, idempotencyKey: key(), override: { reason: "x" } };
    expect(await codeOf(() => withTenant(companyId, (tx) => svc.packOrder(tx, admin, input)))).toBe(
      "CONFLICT",
    );
    const gone = await orderWith(["cancelled"]);
    expect(
      await codeOf(() =>
        withTenant(companyId, (tx) =>
          svc.packOrder(tx, packer, { orderId: gone.order.id, idempotencyKey: key() }),
        ),
      ),
    ).toBe("CONFLICT");
  });

  it("another tenant gets NOT_FOUND for this company's order", async () => {
    const { order } = await orderWith(["packed"]);
    const other = await createCompany();
    const otherCtx = tenantContext(other.id, (await createUser(other.id, "owner")).id, "owner");
    expect(
      await codeOf(() =>
        withTenant(other.id, (tx) =>
          svc.packOrder(tx, otherCtx, { orderId: order.id, idempotencyKey: key() }),
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(await count(floorRequests, eq(floorRequests.orderId, order.id))).toBe(0);
  });
});

describe("order status with a lead hand-off", () => {
  it("never changes the derived status; clears once every open unit is packed or later", () => {
    const f = orderStatusWithOverride;
    expect(f(["packed", "transfer_in"], true)).toEqual({
      status: "in_production",
      clearOverride: false,
    });
    expect(f(["packed", "on_hold"], true)).toEqual({ status: "on_hold", clearOverride: false });
    expect(f(["packed", "cancelled"], true)).toEqual({
      status: "ready_to_ship",
      clearOverride: true,
    });
    expect(f(["shipped", "shipped"], true)).toEqual({ status: "shipped", clearOverride: true });
    expect(f(["cancelled"], true)).toEqual({ status: "cancelled", clearOverride: true });
    expect(f(["packed"], false)).toEqual({ status: "ready_to_ship", clearOverride: false });
  });
});

describe("bins: double taps and the receiving station", () => {
  let companyId: string;
  let ctx: Ctx;
  let orderId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const conn = await createConnection(companyId);
    ctx = tenantContext(companyId, (await createUser(companyId, "packer")).id, "packer");
    orderId = (await createOrder(companyId, conn.id, { units: 2, state: "packed" })).order.id;
  });

  it("assigning and releasing a tote twice records it once", async () => {
    const a1 = await withTenant(companyId, (tx) =>
      svc.assignBin(tx, ctx, { code: "BIN:D1", orderId }),
    );
    const a2 = await withTenant(companyId, (tx) =>
      svc.assignBin(tx, ctx, { code: "BIN:D1", orderId }),
    );
    expect(a2).toMatchObject({ code: "D1", orderId, unitsExpected: a1.unitsExpected });
    const rows = await withTenant(companyId, (tx) =>
      tx.select().from(bins).where(eq(bins.code, "D1")),
    );
    expect(rows).toHaveLength(1);
    const r1 = await withTenant(companyId, (tx) => svc.releaseBin(tx, ctx, { code: "D1" }));
    const r2 = await withTenant(companyId, (tx) => svc.releaseBin(tx, ctx, { code: "D1" }));
    expect(r1.orderId).toBeNull();
    expect(r2.orderId).toBeNull();
    const items = await withTenant(companyId, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    );
    expect(items.every((i) => i.binId === null)).toBe(true);
  });

  it("receiving has no unit queue and a transfer scan there changes nothing", async () => {
    const q = await withTenant(companyId, (tx) =>
      svc.stationQueue(tx, ctx, { station: "receiving", limit: 50 }),
    );
    expect(q.items).toEqual([]);
    const clientScanId = crypto.randomUUID();
    const res = await withTenant(companyId, (tx) =>
      svc.scan(tx, ctx, {
        clientScanId,
        station: "receiving",
        transferCode: "T:00000000-0000-4000-8000-000000000000",
        blankCode: null,
        scannedAt: new Date().toISOString(),
      }),
    );
    expect(res).toMatchObject({ ok: false, mismatch: "wrong_station", clientScanId });
    const stored = await withTenant(companyId, (tx) =>
      tx.select().from(scans).where(eq(scans.clientScanId, clientScanId)),
    );
    expect(stored).toHaveLength(0);
  });
});

describe("who may pack anyway and mark sheets received (router)", () => {
  let companyId: string;
  const session = (role: Role, userId: string): Context => ({
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: userId, name: role, email: `${role}@test.local` },
    emailVerified: true,
    companyId,
    orgType: "shop",
    role,
    permissions: permissionsFor(role),
  });
  const users: Partial<Record<Role, string>> = {};
  const as = (role: Role) => session(role, users[role] ?? "");

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    for (const r of [
      "owner",
      "admin",
      "office",
      "packer",
      "presser",
      "receiver",
      "designer",
    ] as const)
      users[r] = (await createUser(companyId, r)).id;
  });

  it("packOrder's override needs production.override: owner and admin only", async () => {
    const conn = await createConnection(companyId);
    for (const role of ["packer", "office", "receiver", "owner", "admin"] as const) {
      const { order } = await createOrder(companyId, conn.id, { units: 1, state: "pressed" });
      const code = await codeOf(() =>
        call(
          router.production.packOrder,
          { orderId: order.id, idempotencyKey: key(), override: { reason: "lost" } },
          { context: as(role) },
        ),
      );
      expect(code, role).toBe(["owner", "admin"].includes(role) ? "OK" : "FORBIDDEN");
    }
    // Without an override a packer reaches the completeness check.
    const { order } = await createOrder(companyId, conn.id, { units: 1, state: "pressed" });
    expect(
      await codeOf(() =>
        call(
          router.production.packOrder,
          { orderId: order.id, idempotencyKey: key() },
          { context: as("packer") },
        ),
      ),
    ).toBe("PACK_INCOMPLETE");
  });

  it("sheets.markReceived: receiver and office get past the permission check; others don't", async () => {
    const missingSheet = "00000000-0000-4000-8000-000000000001";
    for (const role of ["receiver", "office", "owner", "admin"] as const)
      expect(
        await codeOf(() =>
          call(router.production.sheets.markReceived, { id: missingSheet }, { context: as(role) }),
        ),
        role,
      ).toBe("NOT_FOUND");
    for (const role of ["packer", "presser", "designer"] as const)
      expect(
        await codeOf(() =>
          call(router.production.sheets.markReceived, { id: missingSheet }, { context: as(role) }),
        ),
        role,
      ).toBe("FORBIDDEN");
    // Receiving doesn't widen receiver to building or sending sheets.
    expect(
      await codeOf(() =>
        call(router.production.sheets.cancel, { id: missingSheet }, { context: as("receiver") }),
      ),
    ).toBe("FORBIDDEN");
  });
});
