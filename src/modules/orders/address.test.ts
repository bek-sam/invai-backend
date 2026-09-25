import type { Address } from "@invai/contracts";
import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import { auditLog, buyerPii, orderItems, shipments } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import * as svc from "./service";

const addr = (patch: Partial<Address> = {}): Address => ({
  name: "Ana Buyer",
  company: null,
  street1: "12 Saguaro Ln",
  street2: null,
  city: "Tucson",
  state: "az",
  zip: "85701",
  country: "US",
  phone: null,
  email: null,
  ...patch,
});

describe("orders.updateAddress", () => {
  let companyId: string;
  let connectionId: string;
  let ctx: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    connectionId = (await createConnection(companyId)).id;
    const office = await createUser(companyId, "office");
    ctx = tenantContext(companyId, office.id, "office");
  });

  async function orderWithBadAddress(state: "ready" | "packed" = "ready") {
    const { order, items } = await createOrder(companyId, connectionId, { units: 2, state });
    await withSystem((tx) =>
      tx.insert(buyerPii).values({
        companyId,
        orderId: order.id,
        name: "Ana Buyer",
        email: "ana@example.com",
        street1: "",
        city: "Tucson",
        state: "AZ",
        zip: "857",
      }),
    );
    return { order, items };
  }

  const pii = async (orderId: string) => {
    const [r] = await withSystem((tx) =>
      tx.select().from(buyerPii).where(eq(buyerPii.orderId, orderId)),
    );
    return r;
  };

  it("fixes the address on an address_check hold and releases it", async () => {
    const { order, items } = await orderWithBadAddress();
    await withSystem((tx) =>
      tx
        .update(orderItems)
        .set({
          flags: [
            {
              code: "address_invalid",
              severity: "error",
              message: "bad zip",
              active: true,
              createdAt: new Date().toISOString(),
            },
          ],
        })
        .where(eq(orderItems.orderId, order.id)),
    );
    await withTenant(companyId, (tx) =>
      svc.holdOrder(tx, ctx, { id: order.id, reason: "address_check", note: null }),
    );

    const res = await withTenant(companyId, (tx) =>
      svc.updateAddress(tx, ctx, { id: order.id, address: addr() }),
    );
    expect(res.hold).toBeNull();
    expect(res.status).toBe("new");
    expect(res.items.map((i) => i.state)).toEqual(["ready", "ready"]);
    expect(res.items.every((i) => !i.flags.some((f) => f.code === "address_invalid"))).toBe(true);
    expect(res.shipTo).toMatchObject({ street1: "12 Saguaro Ln", state: "AZ", zip: "85701" });
    // The form carries no email: the channel's stays.
    expect((await pii(order.id))?.email).toBe("ana@example.com");
    expect(items).toHaveLength(2);

    const timeline = await withTenant(companyId, (tx) =>
      svc.timeline(tx, ctx, { id: order.id, limit: 50 }),
    );
    const kinds = timeline.items.map((e) => e.kind);
    expect(kinds).toContain("address_updated");
    expect(kinds).toContain("released");
    const upd = timeline.items.find((e) => e.kind === "address_updated");
    expect(upd?.message).not.toContain("Saguaro");
  });

  it("writes the address without a state change when there's no hold", async () => {
    const { order } = await orderWithBadAddress();
    const res = await withTenant(companyId, (tx) =>
      svc.updateAddress(tx, ctx, { id: order.id, address: addr({ street2: "Apt 4" }) }),
    );
    expect(res.hold).toBeNull();
    expect(res.items.map((i) => i.state)).toEqual(["ready", "ready"]);
    expect(res.shipTo?.street2).toBe("Apt 4");
  });

  it("keeps a hold for another reason", async () => {
    const { order } = await orderWithBadAddress();
    await withTenant(companyId, (tx) =>
      svc.holdOrder(tx, ctx, { id: order.id, reason: "buyer_request", note: null }),
    );
    const res = await withTenant(companyId, (tx) =>
      svc.updateAddress(tx, ctx, { id: order.id, address: addr() }),
    );
    expect(res.hold?.reason).toBe("buyer_request");
    expect(res.status).toBe("on_hold");
  });

  it("is idempotent: the same address twice writes and audits once", async () => {
    const { order } = await orderWithBadAddress();
    await withTenant(companyId, (tx) =>
      svc.updateAddress(tx, ctx, { id: order.id, address: addr() }),
    );
    const before = await pii(order.id);
    await withTenant(companyId, (tx) =>
      svc.updateAddress(tx, ctx, { id: order.id, address: addr() }),
    );
    const after = await pii(order.id);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    const audits = await withSystem((tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, order.id), eq(auditLog.action, "order.address_updated"))),
    );
    expect(audits).toHaveLength(1);
  });

  it("refuses a bad format with ADDRESS_INVALID and writes nothing", async () => {
    const { order } = await orderWithBadAddress();
    for (const bad of [addr({ street1: "  " }), addr({ zip: "8570" }), addr({ city: "" })])
      await expect(
        withTenant(companyId, (tx) => svc.updateAddress(tx, ctx, { id: order.id, address: bad })),
      ).rejects.toMatchObject({ code: "ADDRESS_INVALID", status: 422 });
    expect((await pii(order.id))?.zip).toBe("857");
    await expect(
      withTenant(companyId, (tx) =>
        svc.updateAddress(tx, ctx, { id: order.id, address: addr({ zip: "85701-1234" }) }),
      ),
    ).resolves.toMatchObject({ shipTo: { zip: "85701-1234" } });
  });

  it("refuses ADDRESS_LOCKED once a label exists, and again after the void allows it", async () => {
    const { order, items } = await orderWithBadAddress("packed");
    const [s] = await withSystem((tx) =>
      tx
        .insert(shipments)
        .values({
          companyId,
          orderId: order.id,
          orderItemIds: items.map((i) => i.id),
          status: "labeled",
          labeledAt: new Date(),
        })
        .returning(),
    );
    if (!s) throw new Error("no shipment");
    for (const status of ["labeled", "in_transit", "buying", "voiding"] as const) {
      await withSystem((tx) => tx.update(shipments).set({ status }).where(eq(shipments.id, s.id)));
      await expect(
        withTenant(companyId, (tx) =>
          svc.updateAddress(tx, ctx, { id: order.id, address: addr() }),
        ),
      ).rejects.toMatchObject({ code: "ADDRESS_LOCKED", status: 409 });
    }
    expect((await pii(order.id))?.street1).toBe("");

    await withSystem((tx) =>
      tx
        .update(shipments)
        .set({ status: "voided", voidedAt: new Date() })
        .where(eq(shipments.id, s.id)),
    );
    await expect(
      withTenant(companyId, (tx) => svc.updateAddress(tx, ctx, { id: order.id, address: addr() })),
    ).resolves.toMatchObject({ shipTo: { street1: "12 Saguaro Ln" } });
  });

  it("drops rate quotes taken for the old address", async () => {
    const { order, items } = await orderWithBadAddress("packed");
    const [s] = await withSystem((tx) =>
      tx
        .insert(shipments)
        .values({
          companyId,
          orderId: order.id,
          orderItemIds: items.map((i) => i.id),
          status: "rated",
          ratedAt: new Date(),
          rateQuotes: [
            {
              rateId: "r1",
              carrier: "usps",
              service: "ground_advantage",
              serviceLabel: "Ground Advantage",
              rate: 500,
              deliveryDays: 3,
              estimatedDeliveryAt: null,
            },
          ],
        })
        .returning(),
    );
    if (!s) throw new Error("no shipment");
    await withTenant(companyId, (tx) =>
      svc.updateAddress(tx, ctx, { id: order.id, address: addr() }),
    );
    const [after] = await withSystem((tx) =>
      tx.select().from(shipments).where(eq(shipments.id, s.id)),
    );
    expect(after?.status).toBe("pending");
    expect(after?.rateQuotes).toEqual([]);
  });

  it("returns NOT_FOUND for another company's order", async () => {
    const { order } = await orderWithBadAddress();
    const other = (await createCompany()).id;
    const otherCtx = tenantContext(other, (await createUser(other, "owner")).id, "owner");
    await expect(
      withTenant(other, (tx) => svc.updateAddress(tx, otherCtx, { id: order.id, address: addr() })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await pii(order.id))?.street1).toBe("");
  });

  it("needs orders.manage through the router", async () => {
    const { order } = await orderWithBadAddress();
    const base = anonymousContext(new Headers(), null);
    const as = async (role: "presser" | "office") => {
      const u = await createUser(companyId, role);
      return {
        ...base,
        sessionKind: "user" as const,
        user: { id: u.id, name: u.name, email: u.email },
        companyId,
        orgType: "shop" as const,
        role,
        permissions: permissionsFor(role),
      };
    };
    await expect(
      call(
        router.orders.updateAddress,
        { id: order.id, address: addr() },
        {
          context: await as("presser"),
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        router.orders.updateAddress,
        { id: order.id, address: addr() },
        {
          context: await as("office"),
        },
      ),
    ).resolves.toMatchObject({ id: order.id, shipTo: { street1: "12 Saguaro Ln" } });
  });
});
