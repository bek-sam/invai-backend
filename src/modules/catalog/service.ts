import type { BlankVariant, Design, Product } from "@invai/contracts";
import {
  type BlankImportReport as BlankImportReportSchema,
  BlankVariantInput as BlankVariantInputSchema,
  type DesignInput as DesignInputSchema,
  type ProductInput as ProductInputSchema,
} from "@invai/contracts";
import { and, desc, eq, gt, ilike, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import type { QaIssue, QaStatus } from "../../db/schema";
import { blankVariants, designFiles, designs, orderItems, orders, products } from "../../db/schema";
import { imaging } from "../../integrations/imaging/client";
import { audit } from "../../lib/audit";
import { col, parseCsvObjects } from "../../lib/csv";
import { badRequest, conflict, notFound, upstream } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { getObject, isCompanyKey, objectKey, presignGet } from "../../lib/s3";

const log = logger("catalog");

type DesignInput = z.infer<typeof DesignInputSchema>;
type BlankVariantInput = z.infer<typeof BlankVariantInputSchema>;
type BlankImportReport = z.infer<typeof BlankImportReportSchema>;
type ProductInput = z.infer<typeof ProductInputSchema>;

/*
 * Catalog service: designs (+ print files per placement), blank variants and products.
 * Every function takes the transaction and the tenant context; it never opens its own
 * transaction or touches another module's tables (order_items is read for a count only —
 * the orders module owns writes). Routers call these inside `withTenant()`.
 */

type DesignRow = typeof designs.$inferSelect;
type DesignFileRow = typeof designFiles.$inferSelect;
type BlankRow = typeof blankVariants.$inferSelect;
type ProductRow = typeof products.$inferSelect;

/* ---------------------------------- designs ---------------------------------- */

export type DesignListInput = PageInput & {
  search?: string;
  tag?: string;
  status?: "active" | "archived";
  qaStatus?: QaStatus;
  personalized?: boolean;
};

const QA_RANK: Record<QaStatus, number> = { failed: 3, warn: 2, pending: 1, passed: 0 };

function worstQa(files: DesignFileRow[]): QaStatus {
  return files.reduce<QaStatus>(
    (worst, f) => (QA_RANK[f.qaStatus] > QA_RANK[worst] ? f.qaStatus : worst),
    files.length ? "passed" : "pending",
  );
}

function toDesign(row: DesignRow, files: DesignFileRow[], ordersLast30d: number): Design {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    tags: row.tags,
    placements: files.map((f) => ({
      placement: f.placement,
      fileKey: f.fileKey,
      previewKey: f.previewKey,
      widthIn: f.widthIn,
      heightIn: f.heightIn,
      qa: {
        status: f.qaStatus,
        effectiveDpi: f.effectiveDpi,
        issues: f.qaIssues,
        checkedAt: f.qaCheckedAt?.toISOString() ?? null,
      },
    })),
    personalizationTemplateId: row.personalizationTemplateId,
    qaStatus: worstQa(files),
    ocrText: row.ocrText,
    ordersLast30d,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function hydrateDesigns(tx: Tx, rows: DesignRow[]): Promise<Design[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const files = await tx
    .select()
    .from(designFiles)
    .where(inArray(designFiles.designId, ids))
    .orderBy(designFiles.placement);
  const since = new Date(Date.now() - 30 * 86400_000);
  const counts = await tx
    .select({ designId: orderItems.designId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(inArray(orderItems.designId, ids), gt(orders.placedAt, since)))
    .groupBy(orderItems.designId);
  const countBy = new Map(counts.map((c) => [c.designId, c.n]));
  return rows.map((r) =>
    toDesign(
      r,
      files.filter((f) => f.designId === r.id),
      countBy.get(r.id) ?? 0,
    ),
  );
}

export async function listDesigns(tx: Tx, _ctx: TenantContext, input: DesignListInput) {
  const page = keyset(designs.createdAt, designs.id, input);
  const filters: (SQL | undefined)[] = [page.where, eq(designs.status, input.status ?? "active")];
  if (input.search) {
    const q = `%${input.search}%`;
    filters.push(or(ilike(designs.name, q), ilike(designs.code, q)));
  }
  if (input.tag) filters.push(sql`${input.tag} = any(${designs.tags})`);
  if (input.personalized !== undefined) {
    filters.push(
      input.personalized
        ? isNotNull(designs.personalizationTemplateId)
        : sql`${designs.personalizationTemplateId} is null`,
    );
  }
  if (input.qaStatus) {
    filters.push(
      input.qaStatus === "passed"
        ? sql`not exists (select 1 from design_files f where f.design_id = ${designs.id} and f.qa_status <> 'passed') and exists (select 1 from design_files f where f.design_id = ${designs.id})`
        : sql`exists (select 1 from design_files f where f.design_id = ${designs.id} and f.qa_status = ${input.qaStatus})`,
    );
  }
  const rows = await tx
    .select()
    .from(designs)
    .where(and(...filters))
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  const hydrated = await hydrateDesigns(tx, rows.slice(0, page.limit));
  const byId = new Map(hydrated.map((d) => [d.id, d]));
  return page.result(rows, (r) => byId.get(r.id) as Design);
}

export async function getDesign(tx: Tx, _ctx: TenantContext, id: string): Promise<Design> {
  const [row] = await tx.select().from(designs).where(eq(designs.id, id)).limit(1);
  if (!row) throw notFound("design", id);
  const [design] = await hydrateDesigns(tx, [row]);
  return design as Design;
}

export async function createDesign(
  tx: Tx,
  ctx: TenantContext,
  input: DesignInput,
): Promise<Design> {
  const [dup] = await tx
    .select({ id: designs.id })
    .from(designs)
    .where(eq(designs.code, input.code))
    .limit(1);
  if (dup) throw conflict(`Design code ${input.code} already exists`);
  const [row] = await tx
    .insert(designs)
    .values({
      companyId: ctx.companyId,
      code: input.code,
      name: input.name,
      tags: input.tags,
      personalizationTemplateId: input.personalizationTemplateId,
    })
    .returning();
  if (!row) throw new Error("design insert failed");
  assertOwnFiles(ctx, input.placements);
  await tx.insert(designFiles).values(
    input.placements.map((p) => ({
      companyId: ctx.companyId,
      designId: row.id,
      placement: p.placement,
      fileKey: p.fileKey,
      widthIn: p.widthIn,
      heightIn: p.heightIn,
    })),
  );
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "design",
    entityId: row.id,
    summary: `Design ${row.code} created`,
  });
  await emit(tx, ctx.companyId, "design.updated", { designId: row.id, qaRequested: true });
  return getDesign(tx, ctx, row.id);
}

/** Design files must be objects this company uploaded (keys are `{companyId}/...`). */
function assertOwnFiles(ctx: TenantContext, placements: { fileKey: string }[]) {
  for (const p of placements) if (!isCompanyKey(ctx.companyId, p.fileKey)) throw notFound("file");
}

export type DesignUpdateInput = Partial<DesignInput> & { id: string };

export async function updateDesign(
  tx: Tx,
  ctx: TenantContext,
  input: DesignUpdateInput,
): Promise<Design> {
  const [row] = await tx.select().from(designs).where(eq(designs.id, input.id)).limit(1);
  if (!row) throw notFound("design", input.id);
  await tx
    .update(designs)
    .set({
      code: input.code ?? row.code,
      name: input.name ?? row.name,
      tags: input.tags ?? row.tags,
      personalizationTemplateId:
        input.personalizationTemplateId === undefined
          ? row.personalizationTemplateId
          : input.personalizationTemplateId,
    })
    .where(eq(designs.id, input.id));
  let qaRequested = false;
  if (input.placements) {
    assertOwnFiles(ctx, input.placements);
    await tx.delete(designFiles).where(eq(designFiles.designId, input.id));
    await tx.insert(designFiles).values(
      input.placements.map((p) => ({
        companyId: ctx.companyId,
        designId: input.id,
        placement: p.placement,
        fileKey: p.fileKey,
        widthIn: p.widthIn,
        heightIn: p.heightIn,
      })),
    );
    qaRequested = true;
  }
  await emit(tx, ctx.companyId, "design.updated", { designId: input.id, qaRequested });
  return getDesign(tx, ctx, input.id);
}

export async function setDesignStatus(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  status: "active" | "archived",
) {
  const [row] = await tx
    .update(designs)
    .set({ status })
    .where(eq(designs.id, id))
    .returning({ id: designs.id });
  if (!row) throw notFound("design", id);
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "design",
    entityId: id,
    summary: `Design ${status}`,
  });
  return getDesign(tx, ctx, id);
}

/**
 * Run imaging QA on every placement file, optionally snapping soft alpha first. Called by the
 * `catalog.runDesignQa` job after create/update and by `designs.runQa` on demand.
 */
export async function runDesignQa(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  opts: { cleanAlpha?: boolean } = {},
) {
  const files = await tx.select().from(designFiles).where(eq(designFiles.designId, id));
  if (files.length === 0) throw notFound("design", id);
  for (const file of files) {
    try {
      let fileKey = file.fileKey;
      if (opts.cleanAlpha) {
        const cleaned = await imaging.cleanAlpha({
          file_key: fileKey,
          out_key: objectKey(ctx.companyId, "design", "png"),
        });
        fileKey = cleaned.key;
      }
      const qa = await imaging.qaCheck({
        file_key: fileKey,
        target_width_in: file.widthIn,
        target_height_in: file.heightIn,
      });
      const status: QaStatus = qa.issues.some((i) => i.severity === "error")
        ? "failed"
        : qa.issues.length > 0
          ? "warn"
          : "passed";
      await tx
        .update(designFiles)
        .set({
          fileKey,
          widthPx: qa.width_px,
          heightPx: qa.height_px,
          effectiveDpi: qa.effective_dpi ?? null,
          qaIssues: qa.issues as QaIssue[],
          qaStatus: status,
          qaCheckedAt: new Date(),
        })
        .where(eq(designFiles.id, file.id));
    } catch (err) {
      log.warn("qa failed", { designId: id, placement: file.placement, error: String(err) });
      throw upstream("imaging", err instanceof Error ? err.message : String(err));
    }
  }
  const design = await getDesign(tx, ctx, id);
  await emit(tx, ctx.companyId, "design.qa_completed", {
    designId: id,
    status: design.qaStatus === "pending" ? "warn" : design.qaStatus,
  });
  return design;
}

/* ---------------------------------- blanks ---------------------------------- */

export type BlankListInput = PageInput & {
  search?: string;
  brand?: string;
  styleCode?: string;
  colorCode?: string;
  sizeCode?: string;
  supplier?: "ssactivewear" | "sanmar" | "other";
  status?: "active" | "archived";
};

export function toBlank(row: BlankRow): BlankVariant {
  return {
    id: row.id,
    brand: row.brand,
    style: row.style,
    styleCode: row.styleCode,
    styleName: row.styleName,
    color: row.color,
    colorCode: row.colorCode,
    colorHex: row.colorHex,
    size: row.size,
    sizeCode: row.sizeCode,
    supplier: row.supplier,
    supplierSku: row.supplierSku,
    cost: row.costCents,
    weightOz: row.weightOz,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const blankSku = (v: { styleCode: string; colorCode: string; sizeCode: string }) =>
  `${v.styleCode}-${v.colorCode}-${v.sizeCode}`.toUpperCase();

export async function listBlanks(tx: Tx, _ctx: TenantContext, input: BlankListInput) {
  const page = keyset(blankVariants.createdAt, blankVariants.id, input);
  const filters: (SQL | undefined)[] = [
    page.where,
    eq(blankVariants.status, input.status ?? "active"),
  ];
  if (input.brand) filters.push(eq(blankVariants.brand, input.brand));
  if (input.styleCode) filters.push(eq(blankVariants.styleCode, input.styleCode));
  if (input.colorCode) filters.push(eq(blankVariants.colorCode, input.colorCode));
  if (input.sizeCode) filters.push(eq(blankVariants.sizeCode, input.sizeCode));
  if (input.supplier) filters.push(eq(blankVariants.supplier, input.supplier));
  if (input.search) {
    const q = `%${input.search}%`;
    filters.push(
      or(
        ilike(blankVariants.sku, q),
        ilike(blankVariants.supplierSku, q),
        ilike(blankVariants.brand, q),
        ilike(blankVariants.style, q),
        ilike(blankVariants.color, q),
      ),
    );
  }
  const rows = await tx
    .select()
    .from(blankVariants)
    .where(and(...filters))
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  return page.result(rows, toBlank);
}

export async function getBlank(tx: Tx, _ctx: TenantContext, id: string): Promise<BlankVariant> {
  const [row] = await tx.select().from(blankVariants).where(eq(blankVariants.id, id)).limit(1);
  if (!row) throw notFound("blank_variant", id);
  return toBlank(row);
}

export async function findBlankByCodes(
  tx: Tx,
  codes: { styleCode: string; colorCode: string; sizeCode: string },
) {
  const [row] = await tx
    .select()
    .from(blankVariants)
    .where(
      and(
        eq(blankVariants.styleCode, codes.styleCode),
        eq(blankVariants.colorCode, codes.colorCode),
        eq(blankVariants.sizeCode, codes.sizeCode),
      ),
    )
    .limit(1);
  return row ?? null;
}

function blankValues(companyId: string, input: BlankVariantInput) {
  return {
    companyId,
    brand: input.brand,
    style: input.style,
    styleCode: input.styleCode.toUpperCase(),
    styleName: input.styleName,
    color: input.color,
    colorCode: input.colorCode.toUpperCase(),
    colorHex: input.colorHex,
    size: input.size,
    sizeCode: input.sizeCode.toUpperCase(),
    sku: blankSku(input),
    supplier: input.supplier,
    supplierSku: input.supplierSku,
    costCents: input.cost,
    weightOz: input.weightOz,
  };
}

export async function createBlank(
  tx: Tx,
  ctx: TenantContext,
  input: BlankVariantInput,
): Promise<BlankVariant> {
  const [row] = await tx
    .insert(blankVariants)
    .values(blankValues(ctx.companyId, input))
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict(`Blank ${blankSku(input)} already exists`);
  return toBlank(row);
}

export async function updateBlank(
  tx: Tx,
  ctx: TenantContext,
  input: Partial<BlankVariantInput> & { id: string },
) {
  const [row] = await tx
    .select()
    .from(blankVariants)
    .where(eq(blankVariants.id, input.id))
    .limit(1);
  if (!row) throw notFound("blank_variant", input.id);
  const merged: BlankVariantInput = {
    ...toBlank(row),
    ...input,
    cost: input.cost ?? row.costCents,
  };
  const [updated] = await tx
    .update(blankVariants)
    .set(blankValues(ctx.companyId, merged))
    .where(eq(blankVariants.id, input.id))
    .returning();
  if (!updated) throw notFound("blank_variant", input.id);
  return toBlank(updated);
}

export async function archiveBlank(tx: Tx, _ctx: TenantContext, id: string) {
  const [row] = await tx
    .update(blankVariants)
    .set({ status: "archived" })
    .where(eq(blankVariants.id, id))
    .returning();
  if (!row) throw notFound("blank_variant", id);
  return toBlank(row);
}

/** Upsert by (brand, styleCode, colorCode, sizeCode). Rows inline or a CSV in S3. */
export async function bulkImportBlanks(
  tx: Tx,
  ctx: TenantContext,
  input: { rows?: BlankVariantInput[]; fileKey?: string },
): Promise<BlankImportReport> {
  const report: BlankImportReport = { created: 0, updated: 0, failed: 0, errors: [] };
  let candidates: { row: number; data: unknown }[] = [];
  if (input.rows) candidates = input.rows.map((data, i) => ({ row: i + 1, data }));
  else if (input.fileKey) {
    if (!isCompanyKey(ctx.companyId, input.fileKey)) throw notFound("file");
    const text = (await getObject(input.fileKey)).toString("utf8");
    const parsed = parseCsvObjects(text);
    candidates = parsed.rows.map((r, i) => ({
      row: i + 2,
      data: {
        brand: col(r, "brand"),
        style: col(r, "style"),
        styleCode: col(r, "styleCode", "style_code"),
        styleName: col(r, "styleName", "style_name") || null,
        color: col(r, "color"),
        colorCode: col(r, "colorCode", "color_code"),
        colorHex: col(r, "colorHex", "color_hex") || null,
        size: col(r, "size"),
        sizeCode: col(r, "sizeCode", "size_code") || col(r, "size"),
        supplier: col(r, "supplier") || "ssactivewear",
        supplierSku: col(r, "supplierSku", "supplier_sku", "sku"),
        cost: Math.round(Number(col(r, "cost", "costCents", "cost_cents")) || 0),
        weightOz: Number(col(r, "weightOz", "weight_oz")) || 6,
      },
    }));
  } else throw badRequest("rows or fileKey is required");

  for (const c of candidates) {
    const parsed = BlankVariantInputSchema.safeParse(c.data);
    if (!parsed.success) {
      report.failed++;
      report.errors.push({
        row: c.row,
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }
    const values = blankValues(ctx.companyId, parsed.data);
    const [result] = await tx
      .insert(blankVariants)
      .values(values)
      .onConflictDoUpdate({
        target: [
          blankVariants.companyId,
          blankVariants.brand,
          blankVariants.styleCode,
          blankVariants.colorCode,
          blankVariants.sizeCode,
        ],
        set: { ...values, updatedAt: new Date() },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (result?.inserted) report.created++;
    else report.updated++;
  }
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "blank_variant",
    summary: `Blank import: ${report.created} created, ${report.updated} updated, ${report.failed} failed`,
  });
  return report;
}

export async function blankFacets(tx: Tx, _ctx: TenantContext) {
  const styles = await tx
    .selectDistinct({
      brand: blankVariants.brand,
      styleCode: blankVariants.styleCode,
      style: blankVariants.style,
      styleName: blankVariants.styleName,
    })
    .from(blankVariants)
    .where(eq(blankVariants.status, "active"))
    .orderBy(blankVariants.brand, blankVariants.styleCode);
  const colors = await tx
    .selectDistinct({
      colorCode: blankVariants.colorCode,
      color: blankVariants.color,
      colorHex: blankVariants.colorHex,
    })
    .from(blankVariants)
    .where(eq(blankVariants.status, "active"))
    .orderBy(blankVariants.colorCode);
  const sizes = await tx
    .selectDistinct({ sizeCode: blankVariants.sizeCode })
    .from(blankVariants)
    .where(eq(blankVariants.status, "active"));
  const order = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];
  return {
    brands: Array.from(new Set(styles.map((s) => s.brand))),
    styles,
    colors: Array.from(new Map(colors.map((c) => [c.colorCode, c])).values()),
    sizes: sizes
      .map((s) => s.sizeCode)
      .sort(
        (a, b) =>
          (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) -
          (order.indexOf(b) === -1 ? 99 : order.indexOf(b)),
      ),
  };
}

/* ---------------------------------- products ---------------------------------- */

export type ProductListInput = PageInput & {
  designId?: string;
  styleCode?: string;
  search?: string;
  status?: "active" | "archived";
};

function toProduct(row: ProductRow, designName: string): Product {
  return {
    id: row.id,
    designId: row.designId,
    designName,
    brand: row.brand,
    styleCode: row.styleCode,
    name: row.name,
    allowedColorCodes: row.allowedColorCodes,
    allowedSizeCodes: row.allowedSizeCodes,
    defaultPlacements: row.defaultPlacements as Product["defaultPlacements"],
    prices: row.prices as Product["prices"],
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listProducts(tx: Tx, _ctx: TenantContext, input: ProductListInput) {
  const page = keyset(products.createdAt, products.id, input);
  const filters: (SQL | undefined)[] = [page.where, eq(products.status, input.status ?? "active")];
  if (input.designId) filters.push(eq(products.designId, input.designId));
  if (input.styleCode) filters.push(eq(products.styleCode, input.styleCode.toUpperCase()));
  if (input.search)
    filters.push(
      or(ilike(products.name, `%${input.search}%`), ilike(designs.name, `%${input.search}%`)),
    );
  const rows = await tx
    .select({ product: products, designName: designs.name })
    .from(products)
    .innerJoin(designs, eq(designs.id, products.designId))
    .where(and(...filters))
    .orderBy(desc(products.createdAt), desc(products.id))
    .limit(page.limit + 1);
  return page.result(
    rows.map((r) => ({ ...r, createdAt: r.product.createdAt, id: r.product.id })),
    (r) => toProduct(r.product, r.designName),
  );
}

export async function getProduct(tx: Tx, _ctx: TenantContext, id: string): Promise<Product> {
  const [row] = await tx
    .select({ product: products, designName: designs.name })
    .from(products)
    .innerJoin(designs, eq(designs.id, products.designId))
    .where(eq(products.id, id))
    .limit(1);
  if (!row) throw notFound("product", id);
  return toProduct(row.product, row.designName);
}

export async function createProduct(
  tx: Tx,
  ctx: TenantContext,
  input: ProductInput,
): Promise<Product> {
  const [design] = await tx
    .select({ id: designs.id })
    .from(designs)
    .where(eq(designs.id, input.designId))
    .limit(1);
  if (!design) throw notFound("design", input.designId);
  const [row] = await tx
    .insert(products)
    .values({
      companyId: ctx.companyId,
      designId: input.designId,
      brand: input.brand,
      styleCode: input.styleCode.toUpperCase(),
      name: input.name,
      allowedColorCodes: input.allowedColorCodes.map((c) => c.toUpperCase()),
      allowedSizeCodes: input.allowedSizeCodes.map((c) => c.toUpperCase()),
      defaultPlacements: input.defaultPlacements,
      prices: input.prices,
    })
    .returning();
  if (!row) throw new Error("product insert failed");
  return getProduct(tx, ctx, row.id);
}

export async function updateProduct(
  tx: Tx,
  ctx: TenantContext,
  input: Partial<ProductInput> & { id: string },
) {
  const [row] = await tx.select().from(products).where(eq(products.id, input.id)).limit(1);
  if (!row) throw notFound("product", input.id);
  await tx
    .update(products)
    .set({
      designId: input.designId ?? row.designId,
      brand: input.brand ?? row.brand,
      styleCode: input.styleCode?.toUpperCase() ?? row.styleCode,
      name: input.name ?? row.name,
      allowedColorCodes:
        input.allowedColorCodes?.map((c) => c.toUpperCase()) ?? row.allowedColorCodes,
      allowedSizeCodes: input.allowedSizeCodes?.map((c) => c.toUpperCase()) ?? row.allowedSizeCodes,
      defaultPlacements: input.defaultPlacements ?? row.defaultPlacements,
      prices: input.prices ?? row.prices,
    })
    .where(eq(products.id, input.id));
  return getProduct(tx, ctx, input.id);
}

export async function archiveProduct(tx: Tx, ctx: TenantContext, id: string) {
  const [row] = await tx
    .update(products)
    .set({ status: "archived" })
    .where(eq(products.id, id))
    .returning({ id: products.id });
  if (!row) throw notFound("product", id);
  return getProduct(tx, ctx, id);
}

/** Composite the design's placement file onto a tinted shirt via imaging /mockup. */
export async function productMockup(
  tx: Tx,
  ctx: TenantContext,
  input: { id: string; colorCode: string; placement: "front" | "back" },
): Promise<{ fileKey: string; url: string }> {
  const product = await getProduct(tx, ctx, input.id);
  const [file] = await tx
    .select()
    .from(designFiles)
    .where(
      and(eq(designFiles.designId, product.designId), eq(designFiles.placement, input.placement)),
    )
    .limit(1);
  if (!file) throw badRequest(`Design has no ${input.placement} print file`);
  const [blank] = await tx
    .select({ colorHex: blankVariants.colorHex })
    .from(blankVariants)
    .where(
      and(
        eq(blankVariants.styleCode, product.styleCode),
        eq(blankVariants.colorCode, input.colorCode.toUpperCase()),
      ),
    )
    .limit(1);
  const outKey = objectKey(ctx.companyId, "mockup", "png");
  try {
    const res = await imaging.mockup({
      design_key: file.fileKey,
      blank_color_hex: blank?.colorHex ?? "#ffffff",
      placement: input.placement,
      out_key: outKey,
    });
    return { fileKey: res.key, url: await presignGet(res.key) };
  } catch (err) {
    throw upstream("imaging", err instanceof Error ? err.message : String(err));
  }
}
