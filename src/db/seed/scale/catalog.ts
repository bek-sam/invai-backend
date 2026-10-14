import { randomUUID } from "node:crypto";
import type { blankVariants, designFiles, designs } from "../../schema";
import { BLANK_STYLES, DESIGNS, PRINT_SIZES, type PrintSize, type rng, SIZES } from "../data";
import type { ScaleProfile } from "./profiles";

type Rng = ReturnType<typeof rng>;

/*
 * The shop catalog of a profile: designs (sizes only from PRINT_SIZES in data.ts), the blank
 * variants of the demo styles, and the SKU pool the orders draw from (design x blank style x
 * color x size). File keys come from a fixed pool of 48 so a company never has more than 50
 * distinct keys (spec AC7). No object exists behind any key: the profile writes no files.
 */
export const ART_KEYS = 18;
export const SHEET_KEYS = 6;

const SIZE_KINDS: PrintSize["kind"][] = [
  "adult",
  "adult",
  "adult",
  "youth",
  "adult",
  "left_chest",
  "adult",
  "back",
  "adult",
  "sleeve",
];

export type BlankRef = {
  id: string;
  styleCode: string;
  colorCode: string;
  sizeCode: string;
  color: string;
  size: string;
  costCents: number;
  weightOz: number;
};
export type DesignRef = { id: string; code: string; name: string; size: PrintSize };
export type SkuRef = { sku: string; design: DesignRef; blank: BlankRef; priceExtraCents: number };

export type Catalog = {
  designRows: (typeof designs.$inferInsert)[];
  designFileRows: (typeof designFiles.$inferInsert)[];
  blankRows: (typeof blankVariants.$inferInsert)[];
  skus: SkuRef[];
  keys: { art: string[]; artPreview: string[]; sheet: string[]; sheetPreview: string[] };
};

export function fileKeys(companyId: string) {
  const nn = (i: number) => String(i).padStart(2, "0");
  return {
    art: Array.from({ length: ART_KEYS }, (_, i) => `${companyId}/scale/art-${nn(i)}.png`),
    artPreview: Array.from(
      { length: ART_KEYS },
      (_, i) => `${companyId}/scale/art-prev-${nn(i)}.png`,
    ),
    sheet: Array.from({ length: SHEET_KEYS }, (_, i) => `${companyId}/scale/sheet-${nn(i)}.png`),
    sheetPreview: Array.from(
      { length: SHEET_KEYS },
      (_, i) => `${companyId}/scale/sheet-prev-${nn(i)}.png`,
    ),
  };
}

export function buildCatalog(companyId: string, profile: ScaleProfile, random: Rng): Catalog {
  const keys = fileKeys(companyId);

  const blanks: BlankRef[] = [];
  const blankRows: Catalog["blankRows"] = [];
  for (const style of BLANK_STYLES) {
    for (const color of style.colors) {
      for (const size of SIZES) {
        const id = randomUUID();
        const costCents = style.baseCostCents + size.upcharge;
        const weightOz = Math.round((style.baseWeightOz + size.weightAdd) * 10) / 10;
        blanks.push({
          id,
          styleCode: style.styleCode,
          colorCode: color.code,
          sizeCode: size.code,
          color: color.name,
          size: size.size,
          costCents,
          weightOz,
        });
        blankRows.push({
          id,
          companyId,
          brand: style.brand,
          style: style.style,
          styleCode: style.styleCode,
          styleName: style.styleName,
          color: color.name,
          colorCode: color.code,
          colorHex: color.hex,
          size: size.size,
          sizeCode: size.code,
          sku: `${style.styleCode}-${color.code}-${size.code}`,
          supplier: "ssactivewear",
          supplierSku: `${style.supplierPrefix}${color.ss}${size.code}`,
          costCents,
          weightOz,
        });
      }
    }
  }

  const designRefs: DesignRef[] = [];
  const designRows: Catalog["designRows"] = [];
  const designFileRows: Catalog["designFileRows"] = [];
  for (let i = 0; i < profile.designs; i++) {
    const base = DESIGNS[i % DESIGNS.length];
    const kind = SIZE_KINDS[i % SIZE_KINDS.length] as PrintSize["kind"];
    const size = PRINT_SIZES[kind];
    const code = `SC${String(i + 1).padStart(4, "0")}`;
    const name = i < DESIGNS.length ? (base?.name ?? code) : `${base?.name ?? "Design"} ${i + 1}`;
    const id = randomUUID();
    designRefs.push({ id, code, name, size });
    designRows.push({ id, companyId, code, name, tags: base?.tags ?? [] });
    designFileRows.push({
      companyId,
      designId: id,
      placement: size.placement,
      fileKey: keys.art[i % ART_KEYS] as string,
      previewKey: keys.artPreview[i % ART_KEYS] as string,
      widthIn: size.widthIn,
      heightIn: size.heightIn,
      widthPx: Math.round(size.widthIn * 300),
      heightPx: Math.round(size.heightIn * 300),
      qaStatus: "passed",
      effectiveDpi: 300,
    });
  }

  // SKU pool: N distinct (design, blank) pairs drawn from the full cartesian product.
  const total = designRefs.length * blanks.length;
  const want = Math.min(profile.skus, total);
  const chosen = new Set<number>();
  while (chosen.size < want) chosen.add(random.int(0, total - 1));
  const skus: SkuRef[] = [...chosen]
    .sort((a, b) => a - b)
    .map((n) => {
      const design = designRefs[Math.floor(n / blanks.length)] as DesignRef;
      const blank = blanks[n % blanks.length] as BlankRef;
      return {
        sku: `${design.code}-${blank.styleCode}-${blank.colorCode}-${blank.sizeCode}`,
        design,
        blank,
        priceExtraCents: blank.styleCode === "CC1717" ? 800 : 0,
      };
    });

  return { designRows, designFileRows, blankRows, skus, keys };
}
