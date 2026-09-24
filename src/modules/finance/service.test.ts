import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { adSpend, blankVariants, orderItems, orders, shipments } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import * as svc from "./service";

describe("finance service", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let blankId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
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
          costCents: 300,
        })
        .returning(),
    );
    blankId = bv?.id as string;
  });

  it("creates cost settings from channel defaults", async () => {
    const s = await withTenant(companyId, (tx) => svc.getCostSettings(tx, ctx));
    expect(s.feeTables.find((t) => t.channel === "etsy")?.transactionPct).toBe(6.5);
    const updated = await withTenant(companyId, (tx) =>
      svc.updateCostSettings(tx, ctx, { laborMinutesPerItem: 6, packagingPerOrder: 60 }),
    );
    expect(updated.laborMinutesPerItem).toBe(6);
    expect(updated.packagingPerOrder).toBe(60);
  });

  it("materializes profit lines and groups them", async () => {
    const conn = await createConnection(companyId, "etsy");
    const { order, items } = await createOrder(companyId, conn.id, {
      units: 2,
      state: "shipped",
      channel: "etsy",
    });
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" }).format(
      order.placedAt,
    );
    await withSystem(async (tx) => {
      await tx
        .update(orderItems)
        .set({ blankVariantId: blankId, printWidthIn: 10, printHeightIn: 10 })
        .where(eq(orderItems.orderId, order.id));
      await tx.update(orders).set({ shippingCents: 500 }).where(eq(orders.id, order.id));
      await tx.insert(shipments).values({
        companyId,
        orderId: order.id,
        orderItemIds: items.map((i) => i.id),
        status: "labeled",
        postageCents: 480,
        labelFeeCents: 4,
        labeledAt: new Date(),
      });
      await tx.insert(adSpend).values({ companyId, day, channel: "etsy", amountCents: 1000 });
    });

    const r = await withTenant(companyId, (tx) =>
      svc.recomputeProfit(tx, ctx, { orderIds: [order.id] }),
    );
    expect(r.lines).toBe(2);

    const p = await withTenant(companyId, (tx) => svc.orderProfit(tx, ctx, order.id));
    // revenue: 2 × $25 + $5 shipping
    expect(p.revenue).toBe(5500);
    expect(p.blankCost).toBe(600);
    expect(p.transferCost).toBe(2 * 100 * 3);
    expect(p.labelCost).toBe(484);
    expect(p.packagingCost).toBe(60);
    expect(p.laborCost).toBe(2 * Math.round((6 * 1800) / 60));
    expect(p.adsCost).toBe(1000);
    // 6.5% × 5500 + 3% × 5500 + 25 + 2 × 20
    expect(p.channelFees).toBe(Math.round(357.5) + Math.round(165 + 25) + 40);
    expect(p.estimated).not.toContain("labelCost");
    expect(p.lines).toHaveLength(2);
    expect(p.net).toBe(
      p.revenue -
        p.channelFees -
        p.blankCost -
        p.transferCost -
        p.labelCost -
        p.packagingCost -
        p.laborCost -
        p.adsCost,
    );

    const period = {
      from: new Date(Date.now() - 86400_000).toISOString(),
      to: new Date(Date.now() + 86400_000).toISOString(),
    };
    const byBlank = await withTenant(companyId, (tx) =>
      svc.getProfit(tx, ctx, { dimension: "blank", period }),
    );
    expect(byBlank.rows[0]?.key).toBe("G64000");
    expect(byBlank.rows[0]?.units).toBe(2);
    expect(byBlank.totals.net).toBe(p.net);
    const byChannel = await withTenant(companyId, (tx) =>
      svc.getProfit(tx, ctx, { dimension: "channel", period }),
    );
    expect(byChannel.rows[0]?.label).toBe("Etsy");

    // cancelling one unit refunds it and drops its costs
    await withSystem((tx) =>
      tx
        .update(orderItems)
        .set({ state: "cancelled" })
        .where(eq(orderItems.id, items[1]?.id as string)),
    );
    await withTenant(companyId, (tx) => svc.recomputeProfit(tx, ctx, { orderIds: [order.id] }));
    const after = await withTenant(companyId, (tx) => svc.orderProfit(tx, ctx, order.id));
    expect(after.refunds).toBe(2750);
    expect(after.blankCost).toBe(300);
  });

  it("parses ad spend CSV values", () => {
    expect(svc.parseCsvDate("2026-09-01")).toBe("2026-09-01");
    expect(svc.parseCsvDate("9/1/26")).toBe("2026-09-01");
    expect(svc.parseCsvDate("13/40/2026")).toBeNull();
    expect(svc.parseCsvAmount("$1,234.50", false)).toBe(123450);
    expect(svc.parseCsvAmount("1250", true)).toBe(1250);
    expect(svc.parseCsvAmount("abc", false)).toBeNull();
  });
});
