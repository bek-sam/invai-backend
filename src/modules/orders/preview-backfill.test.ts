import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../db/client";
import { orderItems } from "../../db/schema";
import { createCompany, createConnection, createLocation, createOrder } from "../../test/fixtures";
import { backfillItemPreviews } from "./preview-backfill";

/*
 * T-P5-2 (B-233 rest): an item mapped to a design before that design's own preview had rendered
 * keeps `artworkPreviewKey` null (mapping.ts copies `designFiles.previewKey`, still null then).
 * This is the function `catalog.renderDesignPreviews` calls once the preview lands, closing the
 * gap without a remap. These tests cover the function directly; `catalog/service.test.ts` covers
 * it wired through `renderDesignPreviews`.
 */
describe("backfillItemPreviews", () => {
  let companyId: string;
  let connId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    await createLocation(companyId);
    connId = (await createConnection(companyId)).id;
  });

  async function itemWith(
    overrides: Partial<typeof orderItems.$inferInsert> = {},
  ): Promise<string> {
    const { items } = await createOrder(companyId, connId, { units: 1 });
    const itemId = items[0]?.id;
    if (!itemId) throw new Error("fixture item missing");
    if (Object.keys(overrides).length > 0) {
      await withTenant(companyId, (tx) =>
        tx.update(orderItems).set(overrides).where(eq(orderItems.id, itemId)),
      );
    }
    return itemId;
  }

  async function previewKeyOf(itemId: string): Promise<string | null> {
    const [row] = await withTenant(companyId, (tx) =>
      tx
        .select({ artworkPreviewKey: orderItems.artworkPreviewKey })
        .from(orderItems)
        .where(eq(orderItems.id, itemId)),
    );
    return row?.artworkPreviewKey ?? null;
  }

  it("sets artworkPreviewKey on an item mapped to the design and placement with no preview yet", async () => {
    const designId = crypto.randomUUID();
    const itemId = await itemWith({ designId, placement: "front" });
    const previewKey = `${companyId}/preview/design/${crypto.randomUUID()}.png`;

    const n = await withTenant(companyId, (tx) =>
      backfillItemPreviews(tx, companyId, { designId, placement: "front", previewKey }),
    );

    expect(n).toBe(1);
    expect(await previewKeyOf(itemId)).toBe(previewKey);
  });

  it("leaves an item with its own artwork, or an already-set preview key, untouched", async () => {
    const designId = crypto.randomUUID();
    const previewKey = `${companyId}/preview/design/${crypto.randomUUID()}.png`;
    const existingKey = `${companyId}/preview/design/already-there.png`;
    const ownArtworkKey = `${companyId}/artwork/rendered.png`;

    const personalized = await itemWith({
      designId,
      placement: "front",
      artworkStatus: "approved",
      artworkKey: ownArtworkKey,
    });
    const alreadyPreviewed = await itemWith({
      designId,
      placement: "front",
      artworkPreviewKey: existingKey,
    });
    const wrongPlacement = await itemWith({ designId, placement: "back" });

    const n = await withTenant(companyId, (tx) =>
      backfillItemPreviews(tx, companyId, { designId, placement: "front", previewKey }),
    );

    // Only the wrong-placement item was untouched *because it didn't match*; the other two were
    // candidates by design+placement but excluded by the artwork/existing-preview guards.
    expect(n).toBe(0);
    expect(await previewKeyOf(personalized)).toBeNull();
    expect(await previewKeyOf(alreadyPreviewed)).toBe(existingKey);
    expect(await previewKeyOf(wrongPlacement)).toBeNull();
  });

  it("is idempotent: running it twice changes nothing more", async () => {
    const designId = crypto.randomUUID();
    const itemId = await itemWith({ designId, placement: "front" });
    const previewKey = `${companyId}/preview/design/${crypto.randomUUID()}.png`;

    await withTenant(companyId, (tx) =>
      backfillItemPreviews(tx, companyId, { designId, placement: "front", previewKey }),
    );
    const secondPreviewKey = `${companyId}/preview/design/${crypto.randomUUID()}.png`;
    const n = await withTenant(companyId, (tx) =>
      backfillItemPreviews(tx, companyId, {
        designId,
        placement: "front",
        previewKey: secondPreviewKey,
      }),
    );

    expect(n).toBe(0);
    expect(await previewKeyOf(itemId)).toBe(previewKey);
  });

  it("stays tenant-scoped: another company's item with the same design id is untouched", async () => {
    const designId = crypto.randomUUID();
    const itemId = await itemWith({ designId, placement: "front" });

    const otherCompanyId = (await createCompany()).id;
    await createLocation(otherCompanyId);
    const otherConn = await createConnection(otherCompanyId);
    const { items: otherItems } = await createOrder(otherCompanyId, otherConn.id, { units: 1 });
    const otherItemId = otherItems[0]?.id;
    if (!otherItemId) throw new Error("fixture item missing");
    // Same designId value by coincidence (impossible in practice: design ids are per company),
    // to prove the query is scoped by company and not just by the id columns.
    await withTenant(otherCompanyId, (tx) =>
      tx
        .update(orderItems)
        .set({ designId, placement: "front" })
        .where(eq(orderItems.id, otherItemId)),
    );

    const previewKey = `${companyId}/preview/design/${crypto.randomUUID()}.png`;
    const n = await withTenant(companyId, (tx) =>
      backfillItemPreviews(tx, companyId, { designId, placement: "front", previewKey }),
    );

    expect(n).toBe(1);
    expect(await previewKeyOf(itemId)).toBe(previewKey);
    const [otherRow] = await withTenant(otherCompanyId, (tx) =>
      tx
        .select({ artworkPreviewKey: orderItems.artworkPreviewKey })
        .from(orderItems)
        .where(eq(orderItems.id, otherItemId)),
    );
    expect(otherRow?.artworkPreviewKey).toBeNull();
  });
});
