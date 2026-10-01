import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTenant } from "../../db/client";
import { designFiles, orderItems } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { createBlank, createDesign } from "../catalog/service";
import { mapItems } from "./mapping";

/*
 * T-P1-4 AC3 coverage gap closed by T-P2-2: mapping a non-personalized design to an item copies
 * the design file's current preview onto the item's `artworkPreviewKey`, so the item shows the
 * same thumbnail as the design list without waiting for its own render.
 */
describe("mapItems copies the design preview onto the item (T-P1-4 AC3)", () => {
  it("sets artworkPreviewKey from the design file's previewKey", async () => {
    const companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    const ctx = tenantContext(companyId, owner.id, "owner");
    const conn = await createConnection(companyId);
    await createLocation(companyId);

    const blank = await withTenant(companyId, (tx) =>
      createBlank(tx, ctx, {
        brand: "Gildan",
        style: "64000",
        styleCode: "G64000",
        styleName: null,
        color: "Black",
        colorCode: "BLK",
        colorHex: null,
        size: "M",
        sizeCode: "M",
        supplier: "ssactivewear",
        supplierSku: "G64-BLK-M",
        cost: 350,
        weightOz: 6,
      }),
    );
    const design = await withTenant(companyId, (tx) =>
      createDesign(tx, ctx, {
        code: "MAP1",
        name: "Mapping design",
        tags: [],
        placements: [
          { placement: "front", fileKey: `${companyId}/design/x.png`, widthIn: 10, heightIn: 11 },
        ],
        personalizationTemplateId: null,
      }),
    );
    const [file] = await withTenant(companyId, (tx) =>
      tx.select().from(designFiles).where(eq(designFiles.designId, design.id)),
    );
    if (!file) throw new Error("fixture file missing");
    // Simulate the preview job having already rendered this placement.
    const previewKey = `${companyId}/preview/design/${file.id}.png`;
    await withTenant(companyId, (tx) =>
      tx.update(designFiles).set({ previewKey }).where(eq(designFiles.id, file.id)),
    );

    const { items } = await createOrder(companyId, conn.id, { units: 1 });

    await withTenant(companyId, (tx) =>
      mapItems(tx, ctx, [items[0]?.id as string], {
        designId: design.id,
        blankVariantId: blank.id,
        ruleId: null,
        via: "manual",
      }),
    );

    const [row] = await withTenant(companyId, (tx) =>
      tx
        .select({ artworkPreviewKey: orderItems.artworkPreviewKey })
        .from(orderItems)
        .where(eq(orderItems.id, items[0]?.id as string)),
    );
    expect(row?.artworkPreviewKey).toBe(previewKey);
  });
});
