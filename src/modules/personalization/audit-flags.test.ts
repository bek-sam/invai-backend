import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { auditLog, blankVariants, orderItems } from "../../db/schema";
import { ImagingError, imaging } from "../../integrations/imaging/client";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { bulkImportBlanks, createDesign } from "../catalog/service";
import { mapItems } from "../orders/mapping";
import { createTemplate, renderItemArtwork } from "./service";

/*
 * T-51-1 (B-302): audit_log is append-only and outlives the buyer-text purge, so the
 * artwork.rendered row holds flag codes and slot names only, never a message or suggestion
 * (they quote the buyer's answer), and a failed render's summary is a fixed sentence.
 */

const DATE_ANSWER = "31/31/2024";
const YEAR_ANSWER = "Class of 2024";

let companyId: string;
let ctx: ReturnType<typeof tenantContext>;
let connectionId: string;
let designId: string;
let blankId: string;

const textSlot = (name: string, sourceQuestion: string) => ({
  name,
  kind: "text" as const,
  xIn: 0.5,
  yIn: 8,
  wIn: 10,
  hIn: 1.6,
  fontFamily: "Inter Bold" as const,
  fontSizePt: 48,
  minFontSizePt: null,
  maxLines: null,
  strokeWidthPt: 0,
  strokeColor: null,
  fit: "fit" as const,
  color: "#1a1a1a",
  align: "center" as const,
  maxChars: 32,
  uppercase: false,
  sourceQuestion,
  required: true,
  placeholder: null,
});

beforeAll(async () => {
  companyId = (await createCompany()).id;
  const owner = await createUser(companyId, "owner");
  ctx = tenantContext(companyId, owner.id, "owner");
  await createLocation(companyId);
  connectionId = (await createConnection(companyId, "etsy")).id;
  await withTenant(companyId, async (tx) => {
    await bulkImportBlanks(tx, ctx, {
      rows: [
        {
          brand: "Gildan",
          style: "64000",
          styleCode: "G64000",
          styleName: null,
          color: "Black",
          colorCode: "BLK",
          colorHex: null,
          size: "M",
          sizeCode: "M",
          supplier: "ssactivewear" as const,
          supplierSku: "BBLKM",
          cost: 289,
          weightOz: 5.3,
        },
      ],
    });
    const template = await createTemplate(tx, ctx, {
      name: "Wedding tee",
      widthIn: 11,
      heightIn: 12,
      backgroundKey: null,
      dpi: 300,
      slots: [textSlot("wedding_date", "Date"), textSlot("class_year", "Class of")],
    });
    designId = (
      await createDesign(tx, ctx, {
        code: "P002",
        name: "Wedding tee",
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: `${companyId}/design/p002.png`,
            widthIn: 11,
            heightIn: 12,
          },
        ],
        personalizationTemplateId: template.id,
      })
    ).id;
  });
  const [b] = await withTenant(companyId, (tx) => tx.select().from(blankVariants));
  blankId = b?.id as string;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mappedItem() {
  const { items } = await createOrder(companyId, connectionId, { units: 1, state: "imported" });
  const itemId = items[0]?.id as string;
  await withSystem((tx) =>
    tx
      .update(orderItems)
      .set({ personalization: [{ question: "Date", answer: DATE_ANSWER, fileUrl: null }] })
      .where(eq(orderItems.id, itemId)),
  );
  await withTenant(companyId, (tx) =>
    mapItems(tx, ctx, [itemId], { designId, blankVariantId: blankId, ruleId: null, via: "rule" }),
  );
  return itemId;
}

const renderAudit = async (itemId: string) => {
  const rows = await withSystem((tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, itemId), eq(auditLog.action, "artwork.rendered"))),
  );
  expect(rows).toHaveLength(1);
  return rows[0] as (typeof rows)[number];
};

const values = { wedding_date: DATE_ANSWER, class_year: YEAR_ANSWER };

describe("artwork.rendered audit row keeps no buyer text", () => {
  it("stores flag code and slot only", async () => {
    const itemId = await mappedItem();
    vi.spyOn(imaging, "renderPersonalization").mockImplementation(async (input) => ({
      key: input.out_key,
      width_px: 3300,
      height_px: 3600,
      flags: [
        {
          slot: "wedding_date",
          code: "suspicious_chars",
          message: `unusual characters: '${DATE_ANSWER}'`,
        },
      ],
    }));
    const { artwork } = await withTenant(companyId, (tx) =>
      renderItemArtwork(tx, ctx, itemId, { values }),
    );
    const row = await renderAudit(itemId);
    const flags = (row.data as { flags: Record<string, unknown>[] }).flags;
    expect(flags.length).toBeGreaterThanOrEqual(3);
    for (const f of flags) expect(Object.keys(f).sort()).toEqual(["code", "slot"]);
    expect(flags.map((f) => f.code)).toContain("suspicious_chars");
    const stored = JSON.stringify(row.data) + row.summary;
    for (const leak of [DATE_ANSWER, YEAR_ANSWER, "2024"]) expect(stored).not.toContain(leak);
    // The office still sees the full message on the item.
    expect(JSON.stringify(artwork.flags)).toContain(DATE_ANSWER);
  });

  it("a failed render's summary is a fixed sentence", async () => {
    const itemId = await mappedItem();
    vi.spyOn(imaging, "renderPersonalization").mockRejectedValue(
      new ImagingError("/render/personalization", 422, `"${DATE_ANSWER}" bad`),
    );
    await withTenant(companyId, (tx) => renderItemArtwork(tx, ctx, itemId, { values }));
    const row = await renderAudit(itemId);
    expect(row.summary).toBe("Personalization render failed");
    expect(JSON.stringify(row.data)).not.toContain("31/31");
    expect(Object.keys(row.data as object).sort()).toEqual([
      "fileKey",
      "flags",
      "orderId",
      "status",
    ]);
  });
});
