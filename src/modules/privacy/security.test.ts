import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { itemArtwork, orderItems, orders, personalizationTemplates } from "../../db/schema";
import { objectKey, putObject } from "../../lib/s3";
import { createCompany, createConnection, createOrder } from "../../test/fixtures";
import { purgeBuyerPii } from "../orders/jobs";
import { createNameTemplate, exists, readBack, seedItemArt } from "./buyer-text.fixtures";
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

describe("buyer-text purge: storage deletes stay inside the unit's own objects (T-29-1)", () => {
  const aged = async (orderId: string) =>
    withSystem((tx) =>
      tx
        .update(orders)
        .set({
          shippedAt: new Date(Date.now() - 40 * DAY),
          deliveredAt: new Date(Date.now() - 35 * DAY),
        })
        .where(eq(orders.id, orderId)),
    );

  // Control: keys are deleted only under the unit's own `{company}/` prefix. A unit whose rows
  // point at another company's objects (render, preview, photo, item keys) is purged, and the
  // other company's objects stay.
  it("never deletes another company's objects, even when a unit's keys point at them", async () => {
    const a = (await createCompany()).id;
    const b = (await createCompany()).id;
    const connA = await createConnection(a);
    const bArt = await seedB(b);
    const { order, items } = await createOrder(a, connA.id, { state: "delivered" });
    const item = items[0];
    if (!item) throw new Error("no item");
    const tpl = await createNameTemplate(a);
    await seedItemArt(a, item.id, tpl.id);
    await withSystem(async (tx) => {
      await tx
        .update(orderItems)
        .set({ artworkKey: bArt.art, artworkPreviewKey: bArt.preview })
        .where(eq(orderItems.id, item.id));
      await tx
        .update(itemArtwork)
        .set({
          fileKey: bArt.art,
          previewKey: bArt.preview,
          values: { name: "x", photo: bArt.photo },
        })
        .where(eq(itemArtwork.orderItemId, item.id));
    });
    await aged(order.id);

    await purgeBuyerPii();

    for (const k of [bArt.art, bArt.preview, bArt.photo]) expect(await exists(k)).toBe(true);
    const back = await readBack(a, order.id, item.id);
    expect(back.art?.status).toBe("purged");
    expect(back.item?.artworkKey).toBeNull();
  });

  // S-59 (Low): a buyer-photo key is deleted without checking whether another unit's artwork
  // still uses it (render and item keys get that check, photo-slot values don't). Staff type the
  // photo key into the artwork editor, so one photo reused for two units (a reorder, a second
  // order from the same buyer) loses its object when the first unit's clock runs out, and the
  // unit still in production can no longer be re-rendered. Remove `.fails` when fixed.
  it.fails("keeps a buyer photo that a unit still in production uses", async () => {
    const c = (await createCompany()).id;
    const conn = await createConnection(c);
    const tpl = await createNameTemplate(c);
    const done = await createOrder(c, conn.id, { state: "delivered" });
    const live = await createOrder(c, conn.id, { state: "ready" });
    const doneItem = done.items[0];
    const liveItem = live.items[0];
    if (!doneItem || !liveItem) throw new Error("no item");
    const art = await seedItemArt(c, doneItem.id, tpl.id);
    await seedItemArt(c, liveItem.id, tpl.id);
    await withSystem((tx) =>
      tx
        .update(itemArtwork)
        .set({ values: { name: "Second", photo: art.photoKey } })
        .where(eq(itemArtwork.orderItemId, liveItem.id)),
    );
    await aged(done.order.id);

    await purgeBuyerPii();

    const live2 = await readBack(c, live.order.id, liveItem.id);
    expect(live2.art?.values.photo).toBe(art.photoKey);
    expect(await exists(art.photoKey)).toBe(true);
  });
});

async function seedB(b: string) {
  return {
    art: await putObject(objectKey(b, "artwork", "png"), "b", "image/png"),
    preview: await putObject(objectKey(b, "artwork", "png"), "b", "image/png"),
    photo: await putObject(objectKey(b, "photo", "jpg"), "b", "image/jpeg"),
  };
}
