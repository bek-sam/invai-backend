import { eq } from "drizzle-orm";
import { withSystem, withTenant } from "../../db/client";
import {
  itemArtwork,
  orderItems,
  orders,
  personalizationTemplates,
  refundEvents,
  reprints,
  type TemplateSlot,
} from "../../db/schema";
import { headObject, objectKey, putObject } from "../../lib/s3";

/*
 * Test helpers for the buyer-text purge (T-29-1): a personalized unit with its rendered art,
 * preview and a buyer photo stored in MinIO, plus every free-text note the purge clears.
 * Used by the privacy, orders and production tests; imported only from test files.
 */

const slot = (name: string, kind: "text" | "photo"): TemplateSlot => ({
  name,
  kind,
  xIn: 0.5,
  yIn: 1,
  wIn: 10,
  hIn: 2,
  fontFamily: "Inter Bold",
  fontSizePt: 48,
  minFontSizePt: null,
  maxLines: null,
  strokeWidthPt: 0,
  strokeColor: null,
  fit: "fit",
  color: "#111111",
  align: "center",
  maxChars: 20,
  uppercase: false,
  sourceQuestion: name,
  required: kind === "text",
  placeholder: null,
});

export async function createNameTemplate(companyId: string) {
  return withSystem(async (tx) => {
    const [tpl] = await tx
      .insert(personalizationTemplates)
      .values({
        companyId,
        name: "Name + photo tee",
        widthIn: 10,
        heightIn: 12,
        dpi: 300,
        slots: [slot("name", "text"), slot("photo", "photo")],
      })
      .returning();
    if (!tpl) throw new Error("template insert failed");
    return tpl;
  });
}

export type SeededArt = {
  fileKey: string;
  previewKey: string;
  photoKey: string;
  text: string;
};

/** Give one unit buyer answers, an approved render (objects in MinIO) and artwork flags. */
export async function seedItemArt(
  companyId: string,
  itemId: string,
  templateId: string,
  text = `Probe ${itemId.slice(0, 6)}`,
): Promise<SeededArt> {
  const fileKey = await putObject(objectKey(companyId, "artwork", "png"), text, "image/png");
  const previewKey = await putObject(objectKey(companyId, "artwork", "png"), text, "image/png");
  const photoKey = await putObject(objectKey(companyId, "photo", "jpg"), "jpg", "image/jpeg");
  await withSystem(async (tx) => {
    await tx
      .update(orderItems)
      .set({
        personalization: [{ question: "name", answer: text, fileUrl: "https://cdn.test/p.jpg" }],
        artworkStatus: "approved",
        artworkKey: fileKey,
        artworkPreviewKey: previewKey,
        flags: [
          {
            code: "artwork_typo",
            severity: "warn",
            message: `name: "${text}" looks like a typo`,
            active: true,
            createdAt: new Date().toISOString(),
          },
          {
            code: "address_check",
            severity: "warn",
            message: "Address needs a look",
            active: true,
            createdAt: new Date().toISOString(),
          },
        ],
      })
      .where(eq(orderItems.id, itemId));
    await tx.insert(itemArtwork).values({
      companyId,
      orderItemId: itemId,
      templateId,
      values: { name: text, photo: photoKey },
      fileKey,
      previewKey,
      flags: [{ slot: "name", code: "odd_date", message: `"${text}" is odd`, suggestion: null }],
      error: `render note about ${text}`,
      status: "approved",
    });
  });
  return { fileKey, previewKey, photoKey, text };
}

/** Every free-text note the purge clears, on one order and one of its units. */
export async function seedNotes(companyId: string, orderId: string, itemId: string, text: string) {
  await withSystem(async (tx) => {
    await tx
      .update(orders)
      .set({ buyerNote: text, holdNote: text, cancelNote: text })
      .where(eq(orders.id, orderId));
    await tx.insert(refundEvents).values({
      companyId,
      orderId,
      orderItemId: itemId,
      channel: "csv",
      source: "manual",
      amountCents: 500,
      refundedAt: new Date(),
      note: text,
    });
    await tx
      .insert(reprints)
      .values({ companyId, orderItemId: itemId, reason: "misprint", note: text });
  });
}

export async function exists(key: string) {
  return (await headObject(key)).exists;
}

/** The item, its artwork row, its reprints and the order with its refunds, read as the tenant. */
export async function readBack(companyId: string, orderId: string, itemId: string) {
  return withTenant(companyId, async (tx) => ({
    order: (await tx.select().from(orders).where(eq(orders.id, orderId)))[0],
    item: (await tx.select().from(orderItems).where(eq(orderItems.id, itemId)))[0],
    art: (await tx.select().from(itemArtwork).where(eq(itemArtwork.orderItemId, itemId)))[0],
    reprints: await tx.select().from(reprints).where(eq(reprints.orderItemId, itemId)),
    refunds: await tx.select().from(refundEvents).where(eq(refundEvents.orderId, orderId)),
  }));
}
