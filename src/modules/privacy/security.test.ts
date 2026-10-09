import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { itemArtwork, orderItems, orders, personalizationTemplates } from "../../db/schema";
import { createCompany, createConnection, createOrder } from "../../test/fixtures";
import { buyerPiiCutoff, redactStaleBuyerPii, sweepStaleAmazonData } from "./service";

const DAY = 86400_000;

describe("privacy retention: personalization copies", () => {
  // S-56 (T-28-3 security review): `item_artwork.values` is a copy of the buyer's personalization
  // answers (`valuesFromAnswers`, personalization/service.ts). The 30-day purge, the 18-month PII
  // sweep and the Amazon sweep (decision 0026 lists item_artwork as "keep, no Amazon content")
  // all leave it, so a buyer's custom text outlives every retention window. Remove `.fails` when fixed.
  it("an 18-month-old delivered Amazon order keeps no buyer personalization text", async () => {
    const companyId = (await createCompany()).id;
    const conn = await createConnection(companyId, "amazon");
    const { order, items } = await createOrder(companyId, conn.id, {
      channel: "amazon",
      state: "delivered",
    });
    const item = items[0];
    if (!item) throw new Error("no item");
    const placedAt = new Date(buyerPiiCutoff().getTime() - DAY);
    await withSystem(async (tx) => {
      await tx
        .update(orders)
        .set({ placedAt, status: "delivered", shippedAt: placedAt })
        .where(eq(orders.id, order.id));
      await tx
        .update(orderItems)
        .set({ personalization: [{ question: "Name", answer: "Probe Buyername", fileUrl: null }] })
        .where(eq(orderItems.id, item.id));
      const [tpl] = await tx
        .insert(personalizationTemplates)
        .values({ companyId, name: "Name tee", widthIn: 10, heightIn: 4, dpi: 300, slots: [] })
        .returning();
      if (!tpl) throw new Error("no template");
      await tx.insert(itemArtwork).values({
        companyId,
        orderItemId: item.id,
        templateId: tpl.id,
        values: { name: "Probe Buyername" },
        status: "approved",
      });
    });

    await redactStaleBuyerPii();
    await sweepStaleAmazonData();

    const after = await withTenant(companyId, async (tx) => ({
      item: (await tx.select().from(orderItems).where(eq(orderItems.id, item.id)))[0],
      art: (await tx.select().from(itemArtwork).where(eq(itemArtwork.orderItemId, item.id)))[0],
    }));
    // The order item copy is redacted today (control holds) ...
    expect(JSON.stringify(after.item?.personalization)).not.toContain("Probe Buyername");
    // ... the artwork copy is not (the finding).
    expect(JSON.stringify(after.art?.values ?? {})).not.toContain("Probe Buyername");
  });
});
