import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { blankVariants, orderItems, outboxEvents, stockLevels } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { crossedBelow, movementDelta, recordMovement } from "./ledger";
import * as svc from "./service";

describe("ledger math", () => {
  it("maps movement kinds to counter deltas", () => {
    expect(movementDelta("receive", 10)).toEqual({ onHand: 10, reserved: 0 });
    expect(movementDelta("consume", -1)).toEqual({ onHand: -1, reserved: 0 });
    expect(movementDelta("reserve", 2)).toEqual({ onHand: 0, reserved: 2 });
    expect(movementDelta("release", 2)).toEqual({ onHand: 0, reserved: -2 });
    expect(movementDelta("scrap", -1)).toEqual({ onHand: -1, reserved: 0 });
  });

  it("detects crossing below the reorder point once", () => {
    expect(crossedBelow(8, 7, 8)).toBe(true);
    expect(crossedBelow(7, 6, 8)).toBe(false);
    expect(crossedBelow(9, 8, 8)).toBe(false);
    expect(crossedBelow(9, 1, null)).toBe(false);
  });
});

describe("item reservations", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let locationId: string;
  let blankId: string;

  const level = () =>
    withTenant(companyId, async (tx) => {
      const [row] = await tx
        .select()
        .from(stockLevels)
        .where(
          and(eq(stockLevels.blankVariantId, blankId), eq(stockLevels.locationId, locationId)),
        );
      return row;
    });

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    locationId = (await createLocation(companyId)).id;
    const [bv] = await withSystem((tx) =>
      tx
        .insert(blankVariants)
        .values({
          companyId,
          brand: "Gildan",
          style: "Softstyle",
          styleCode: "G64000",
          color: "Black",
          colorCode: "BLK",
          size: "M",
          sizeCode: "M",
          sku: "G64000-BLK-M",
          costCents: 250,
          reorderPoint: 9,
        })
        .returning(),
    );
    blankId = bv?.id as string;
    await withTenant(companyId, (tx) =>
      recordMovement(tx, ctx, { blankVariantId: blankId, locationId, kind: "receive", qty: 10 }),
    );
  });

  it("reserves, releases and consumes idempotently", async () => {
    const conn = await createConnection(companyId);
    const { items } = await createOrder(companyId, conn.id, { units: 2, state: "ready" });
    const ids = items.map((i) => i.id);
    await withSystem((tx) =>
      tx
        .update(orderItems)
        .set({ blankVariantId: blankId })
        .where(eq(orderItems.orderId, items[0]?.orderId as string)),
    );

    expect(await withTenant(companyId, (tx) => svc.reserveForItems(tx, ctx, ids))).toBe(2);
    expect(await withTenant(companyId, (tx) => svc.reserveForItems(tx, ctx, ids))).toBe(0);
    let l = await level();
    expect(l).toMatchObject({ onHand: 10, reserved: 2, available: 8 });

    // available 8 < reorder point 9: a stock.low event was written
    const low = await withSystem((tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.companyId, companyId), eq(outboxEvents.name, "stock.low"))),
    );
    expect(low).toHaveLength(1);

    // one item cancelled, one pressed
    expect(
      await withTenant(companyId, (tx) => svc.releaseForItems(tx, ctx, [ids[0] as string])),
    ).toBe(1);
    expect(
      await withTenant(companyId, (tx) => svc.releaseForItems(tx, ctx, [ids[0] as string])),
    ).toBe(0);
    const pressed = await withTenant(companyId, (tx) =>
      svc.consumeForItem(tx, ctx, ids[1] as string),
    );
    expect(pressed?.kind).toBe("consume");
    l = await level();
    expect(l).toMatchObject({ onHand: 9, reserved: 0, available: 9 });

    // a re-press after QC failure is booked as scrap
    const again = await withTenant(companyId, (tx) =>
      svc.consumeForItem(tx, ctx, ids[1] as string),
    );
    expect(again?.kind).toBe("scrap");
    l = await level();
    expect(l).toMatchObject({ onHand: 8, reserved: 0, available: 8 });
  });

  it("returns shelves for blanks", async () => {
    await withTenant(companyId, (tx) =>
      tx
        .update(stockLevels)
        .set({ shelf: "A-01-1" })
        .where(eq(stockLevels.blankVariantId, blankId)),
    );
    const shelves = await withTenant(companyId, (tx) =>
      svc.getShelvesForBlanks(tx, ctx, [blankId, crypto.randomUUID()]),
    );
    expect(shelves.get(blankId)).toBe("A-01-1");
    expect([...shelves.values()]).toContain(null);
  });
});
