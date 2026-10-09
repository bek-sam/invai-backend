import type {
  ArtworkFlag as ContractArtworkFlag,
  ItemArtwork,
  PersonalizationTemplate,
  PersonalizationTemplateInput as TemplateInputSchema,
} from "@invai/contracts";
import { and, eq, ilike, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx, withTenant } from "../../db/client";
import {
  type ArtworkFlag,
  designs,
  itemArtwork,
  orderItems,
  orders,
  type PersonalizationAnswer,
  personalizationTemplates,
  type TemplateSlot,
} from "../../db/schema";
import { ImagingError, imaging } from "../../integrations/imaging/client";
import { audit } from "../../lib/audit";
import { badRequest, conflict, notFound, ORPCError, upstream } from "../../lib/errors";
import { errorData, logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { publish } from "../../lib/realtime";
import { deleteObject, isCompanyKey, objectKey, presignGet } from "../../lib/s3";
import { ARTWORK_ITEM_FLAGS, ARTWORK_TO_ITEM_FLAG, withFlags } from "../orders/flags";
import { transitionItem } from "../orders/state-machine";

const log = logger("personalization");

type TemplateInput = z.infer<typeof TemplateInputSchema>;
type TemplateRow = typeof personalizationTemplates.$inferSelect;
type ArtworkRow = typeof itemArtwork.$inferSelect;

/* ------------------------------------ templates ------------------------------------ */

function toTemplate(r: TemplateRow, designCount: number): PersonalizationTemplate {
  return {
    id: r.id,
    name: r.name,
    widthIn: r.widthIn,
    heightIn: r.heightIn,
    backgroundKey: r.backgroundKey,
    dpi: r.dpi,
    slots: r.slots,
    designCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function designCounts(tx: Tx, ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  const rows = await tx
    .select({ id: designs.personalizationTemplateId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(designs)
    .where(inArray(designs.personalizationTemplateId, ids))
    .groupBy(designs.personalizationTemplateId);
  return new Map(rows.map((r) => [r.id as string, r.n]));
}

function validateSlots(input: { widthIn: number; heightIn: number; slots: TemplateSlot[] }) {
  const names = new Set<string>();
  for (const s of input.slots) {
    if (names.has(s.name)) throw badRequest(`Slot name "${s.name}" is used twice`);
    names.add(s.name);
    if (s.xIn + s.wIn > input.widthIn + 1e-6 || s.yIn + s.hIn > input.heightIn + 1e-6)
      throw badRequest(
        `Slot "${s.name}" extends outside the ${input.widthIn}x${input.heightIn} in canvas`,
      );
  }
}

export async function listTemplates(
  tx: Tx,
  _ctx: TenantContext,
  input: PageInput & { search?: string },
) {
  const page = keyset(personalizationTemplates.createdAt, personalizationTemplates.id, input);
  const rows = await tx
    .select()
    .from(personalizationTemplates)
    .where(
      and(
        page.where,
        input.search ? ilike(personalizationTemplates.name, `%${input.search}%`) : undefined,
      ),
    )
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  const counts = await designCounts(
    tx,
    rows.map((r) => r.id),
  );
  return page.result(rows, (r) => toTemplate(r, counts.get(r.id) ?? 0));
}

async function templateRow(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(personalizationTemplates)
    .where(eq(personalizationTemplates.id, id))
    .limit(1);
  if (!row) throw notFound("personalization_template", id);
  return row;
}

export async function getTemplate(tx: Tx, _ctx: TenantContext, id: string) {
  const row = await templateRow(tx, id);
  return toTemplate(row, (await designCounts(tx, [id])).get(id) ?? 0);
}

/** Background art must be an object this company uploaded; imaging reads it by key. */
function assertOwnBackground(ctx: TenantContext, key: string | null | undefined) {
  if (key && !isCompanyKey(ctx.companyId, key)) throw notFound("file");
}

export async function createTemplate(tx: Tx, ctx: TenantContext, input: TemplateInput) {
  validateSlots(input);
  assertOwnBackground(ctx, input.backgroundKey);
  const [row] = await tx
    .insert(personalizationTemplates)
    .values({ companyId: ctx.companyId, ...input })
    .returning();
  if (!row) throw new Error("template insert failed");
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "personalization_template",
    entityId: row.id,
    summary: `Personalization template "${row.name}" created`,
  });
  return toTemplate(row, 0);
}

export async function updateTemplate(
  tx: Tx,
  ctx: TenantContext,
  input: Partial<TemplateInput> & { id: string },
) {
  assertOwnBackground(ctx, input.backgroundKey);
  const row = await templateRow(tx, input.id);
  const next = {
    name: input.name ?? row.name,
    widthIn: input.widthIn ?? row.widthIn,
    heightIn: input.heightIn ?? row.heightIn,
    backgroundKey: input.backgroundKey === undefined ? row.backgroundKey : input.backgroundKey,
    dpi: input.dpi ?? row.dpi,
    slots: input.slots ?? row.slots,
  };
  validateSlots(next);
  await tx
    .update(personalizationTemplates)
    .set(next)
    .where(eq(personalizationTemplates.id, input.id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "personalization_template",
    entityId: row.id,
    summary: `Personalization template "${next.name}" updated`,
  });
  return getTemplate(tx, ctx, input.id);
}

export async function deleteTemplate(tx: Tx, ctx: TenantContext, id: string) {
  const row = await templateRow(tx, id);
  const count = (await designCounts(tx, [id])).get(id) ?? 0;
  if (count > 0)
    throw new ORPCError("TEMPLATE_IN_USE", {
      status: 409,
      message: "Designs still use this template",
      data: { designCount: count },
    });
  const [used] = await tx
    .select({ id: itemArtwork.id })
    .from(itemArtwork)
    .where(eq(itemArtwork.templateId, id))
    .limit(1);
  if (used) throw conflict("Order items were rendered with this template; it cannot be deleted");
  await tx.delete(personalizationTemplates).where(eq(personalizationTemplates.id, id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "personalization_template",
    entityId: id,
    summary: `Personalization template "${row.name}" deleted`,
  });
  return { ok: true as const };
}

/* ------------------------------------ rendering ------------------------------------ */

const normQ = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Buyer answers -> slot values. Matches each slot's `sourceQuestion` (or name) against the
 * channel question; a single free-text answer (Etsy "Personalization") is split on `key: value`
 * lines, or fills the first required slot when it has no keys.
 */
export function valuesFromAnswers(
  slots: TemplateSlot[],
  answers: PersonalizationAnswer[],
): Record<string, string> {
  const values: Record<string, string> = {};
  const qa = answers
    .filter((a) => a.answer !== null && a.answer !== undefined)
    .map((a) => ({ q: normQ(a.question), a: String(a.answer).trim() }));
  const keyOf = (s: TemplateSlot) => normQ(s.sourceQuestion ?? s.name);

  for (const s of slots) {
    const key = keyOf(s);
    const hit =
      qa.find((x) => x.q === key) ??
      qa.find((x) => x.q.includes(key) || (x.q && key.includes(x.q)));
    if (hit) values[s.name] = hit.a;
  }
  if (Object.keys(values).length === 0 && qa.length > 0) {
    const text = qa.map((x) => x.a).join("\n");
    const pairs = text
      .split(/\n|,|;/)
      .map((p) => /^\s*([^:=]+?)\s*[:=]\s*(.+)$/.exec(p))
      .filter((m): m is RegExpExecArray => !!m);
    for (const s of slots) {
      const key = keyOf(s);
      const hit = pairs.find(
        (m) => normQ(m[1] as string) === key || normQ(m[1] as string).includes(key),
      );
      if (hit) values[s.name] = (hit[2] as string).trim();
    }
    if (Object.keys(values).length === 0) {
      const target = slots.find((s) => s.required) ?? slots[0];
      if (target) values[target.name] = text.trim();
    }
  }
  return values;
}

const DATE_RE = [
  /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/,
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  /^[A-Za-z]{3,9}\.? \d{1,2},? \d{4}$/,
  /^\d{4}$/,
];

/** Checks imaging does not do: missing required answers, dates and years that look wrong. */
export function localFlags(slots: TemplateSlot[], values: Record<string, string>): ArtworkFlag[] {
  const flags: ArtworkFlag[] = [];
  for (const s of slots) {
    const v = (values[s.name] ?? "").trim();
    const label = `${s.name}`.toLowerCase();
    if (!v) {
      if (s.required)
        flags.push({
          slot: s.name,
          code: "missing_answer",
          message: `No answer for "${s.sourceQuestion ?? s.name}"`,
          suggestion: null,
        });
      continue;
    }
    // A photo slot's value is a storage key, not buyer text; the date/year heuristics below
    // only make sense for text slots.
    if (s.kind === "photo") continue;
    if (/date/.test(label)) {
      const ok = DATE_RE.some((re) => re.test(v));
      const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(v);
      const badParts = m && Number(m[1]) > 12 && Number(m[2]) > 12;
      if (!ok || badParts)
        flags.push({
          slot: s.name,
          code: "odd_date",
          message: `"${v}" does not look like a date`,
          suggestion: null,
        });
    } else if (
      /year|class/.test(label) ||
      /class of|year/.test((s.sourceQuestion ?? "").toLowerCase())
    ) {
      const n = Number(v);
      if (!/^\d{4}$/.test(v) || n < 1900 || n > 2100) {
        const four = /(19|20)\d{2}/.exec(v)?.[0] ?? null;
        flags.push({
          slot: s.name,
          code: "odd_date",
          message: `"${v}" is not a 4-digit year`,
          suggestion: four,
        });
      }
    }
  }
  return flags;
}

export type RenderOutcome = {
  status: "rendered" | "flagged" | "failed";
  fileKey: string | null;
  widthPx: number | null;
  heightPx: number | null;
  flags: ArtworkFlag[];
  error: string | null;
  /** A failure worth retrying (imaging down, 5xx, 429, timeout) rather than a refused request. */
  transient?: boolean;
};

function renderTemplatePayload(
  t: Pick<TemplateRow, "widthIn" | "heightIn" | "backgroundKey" | "slots">,
) {
  return {
    width_in: t.widthIn,
    height_in: t.heightIn,
    ...(t.backgroundKey ? { background_key: t.backgroundKey } : {}),
    slots: t.slots.map((s) => ({
      name: s.name,
      kind: s.kind,
      x_in: s.xIn,
      y_in: s.yIn,
      w_in: s.wIn,
      h_in: s.hIn,
      font_family: s.fontFamily,
      font_size_pt: s.fontSizePt,
      min_font_size_pt: s.minFontSizePt,
      max_lines: s.maxLines,
      stroke_width_pt: s.strokeWidthPt,
      stroke_color: s.strokeColor,
      fit: s.fit,
      color: s.color,
      align: s.align,
      ...(s.maxChars ? { max_chars: s.maxChars } : {}),
      uppercase: s.uppercase,
    })),
  };
}

/** Render values through imaging and merge imaging's flags with the local checks. */
export async function renderValues(
  template: Pick<TemplateRow, "widthIn" | "heightIn" | "backgroundKey" | "slots" | "dpi">,
  values: Record<string, string>,
  outKey: string,
): Promise<RenderOutcome> {
  const local = localFlags(template.slots, values);
  try {
    const res = await imaging.renderPersonalization({
      template: renderTemplatePayload(template),
      values,
      out_key: outKey,
      dpi: template.dpi,
    });
    const remote: ArtworkFlag[] = res.flags
      // An empty optional slot is fine; an empty required slot is already `missing_answer`.
      .filter((f) => f.code !== "empty")
      .map((f) => ({ slot: f.slot, code: f.code, message: f.message, suggestion: null }));
    const flags = [...local, ...remote];
    return {
      status: flags.length ? "flagged" : "rendered",
      fileKey: res.key,
      widthPx: res.width_px,
      heightPx: res.height_px,
      flags,
      error: null,
    };
  } catch (err) {
    const detail = err instanceof ImagingError ? err.detail : String(err);
    log.warn("personalization render failed", { error: detail });
    return {
      status: "failed",
      fileKey: null,
      widthPx: null,
      heightPx: null,
      flags: local,
      error: detail,
      transient: !(err instanceof ImagingError) || err.status >= 500 || err.status === 429,
    };
  }
}

export async function previewTemplate(
  tx: Tx,
  ctx: TenantContext,
  input: { id: string; values: Record<string, string> },
) {
  const t = await templateRow(tx, input.id);
  const key = objectKey(ctx.companyId, "preview", "png");
  const out = await renderValues(t, input.values, key);
  if (out.status === "failed" || !out.fileKey) throw upstream("imaging", out.error);
  return {
    previewKey: out.fileKey,
    previewUrl: await presignGet(out.fileKey, 3600),
    widthPx: out.widthPx ?? 1,
    heightPx: out.heightPx ?? 1,
    flags: out.flags as ContractArtworkFlag[],
  };
}

/* ------------------------------------ item artwork ------------------------------------ */

type ItemRow = typeof orderItems.$inferSelect;

async function applyOutcomeToItem(
  tx: Tx,
  ctx: TenantContext,
  item: ItemRow,
  outcome: {
    status: ArtworkRow["status"];
    fileKey: string | null;
    flags: ArtworkFlag[];
    error?: string | null;
  },
) {
  const itemFlags = outcome.flags
    .map((f) => ({
      code: ARTWORK_TO_ITEM_FLAG[f.code] ?? "manual_review",
      severity: (f.code === "too_long" || f.code === "odd_date" ? "warn" : "error") as
        | "warn"
        | "error",
      message: f.slot ? `${f.slot}: ${f.message}` : f.message,
    }))
    .concat(
      outcome.status === "failed"
        ? [
            {
              code: "artwork_qa_failed",
              severity: "error" as const,
              message: outcome.error
                ? `Personalization render failed: ${outcome.error.slice(0, 200)}`
                : "Personalization render failed",
            },
          ]
        : [],
    );
  const flags = withFlags(item.flags, itemFlags, ARTWORK_ITEM_FLAGS);
  await tx
    .update(orderItems)
    .set({
      artworkStatus: outcome.status,
      artworkKey: outcome.fileKey,
      artworkPreviewKey: outcome.fileKey,
      flags,
    })
    .where(eq(orderItems.id, item.id));
  if (itemFlags.length) {
    afterCommit(tx, async () => {
      await publish(ctx.companyId, "item.flagged", {
        orderItemId: item.id,
        orderId: item.orderId,
        codes: itemFlags.map((f) => f.code),
      });
    });
  }
}

type RenderPlan = {
  item: ItemRow;
  existing: ArtworkRow | undefined;
  templateId: string;
  template: TemplateRow;
  values: Record<string, string>;
};

async function planItemRender(
  tx: Tx,
  itemId: string,
  opts: { templateId?: string; values?: Record<string, string> },
): Promise<RenderPlan> {
  const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, itemId)).limit(1);
  if (!item) throw notFound("order_item", itemId);
  const [existing] = await tx
    .select()
    .from(itemArtwork)
    .where(eq(itemArtwork.orderItemId, itemId))
    .limit(1);
  let templateId = opts.templateId ?? existing?.templateId ?? null;
  if (!templateId && item.designId) {
    const [d] = await tx
      .select({ t: designs.personalizationTemplateId })
      .from(designs)
      .where(eq(designs.id, item.designId))
      .limit(1);
    templateId = d?.t ?? null;
  }
  if (!templateId) throw badRequest("This item's design has no personalization template");
  const template = await templateRow(tx, templateId);
  const values =
    opts.values ?? existing?.values ?? valuesFromAnswers(template.slots, item.personalization);
  return { item, existing, templateId, template, values };
}

/** Store a render outcome on item_artwork and mirror its status and flags onto the item. */
async function saveItemRender(
  tx: Tx,
  ctx: TenantContext,
  plan: Omit<RenderPlan, "template">,
  out: RenderOutcome,
): Promise<{ clean: boolean; artwork: ArtworkRow }> {
  const { item, existing, templateId, values } = plan;
  const itemId = item.id;
  const now = new Date();
  const set = {
    templateId,
    values,
    fileKey: out.fileKey,
    previewKey: out.fileKey,
    widthPx: out.widthPx,
    heightPx: out.heightPx,
    flags: out.flags,
    status: out.status,
    error: out.error,
    renderedAt: out.status === "failed" ? (existing?.renderedAt ?? null) : now,
    approvedBy: null,
    approvedAt: null,
  };
  const [artwork] = existing
    ? await tx.update(itemArtwork).set(set).where(eq(itemArtwork.id, existing.id)).returning()
    : await tx
        .insert(itemArtwork)
        .values({ companyId: ctx.companyId, orderItemId: itemId, ...set })
        .returning();
  if (!artwork) throw new Error("artwork upsert failed");
  await applyOutcomeToItem(tx, ctx, item, out);
  // A superseded render still holds the buyer's text, and no purge can find it once its key is
  // gone from the row: delete it after the new outcome is committed (decision 0027).
  // Only render keys (`{companyId}/artwork/...`, a new random key per render) are deleted.
  const superseded = [...new Set([existing?.fileKey, existing?.previewKey])].filter(
    (k): k is string =>
      !!k &&
      k !== out.fileKey &&
      isCompanyKey(ctx.companyId, k) &&
      k.startsWith(`${ctx.companyId}/artwork/`),
  );
  if (superseded.length)
    afterCommit(tx, async () => {
      for (const key of superseded) {
        try {
          await deleteObject(key);
        } catch (err) {
          log.warn("superseded render delete failed", { orderItemId: itemId, ...errorData(err) });
        }
      }
    });

  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "artwork.rendered",
    entityType: "order_item",
    entityId: itemId,
    summary:
      out.status === "failed"
        ? `Personalization render failed: ${out.error ?? "unknown error"}`
        : out.status === "flagged"
          ? `Personalization rendered with ${out.flags.length} flag(s): ${out.flags.map((f) => f.code).join(", ")}`
          : "Personalization rendered",
    data: { orderId: item.orderId, status: out.status, fileKey: out.fileKey, flags: out.flags },
  });
  if (out.fileKey)
    await emit(tx, ctx.companyId, "artwork.rendered", {
      orderItemId: itemId,
      fileKey: out.fileKey,
    });
  if (out.flags.length)
    await emit(tx, ctx.companyId, "artwork.flagged", {
      orderItemId: itemId,
      codes: out.flags.map((f) => f.code),
    });
  afterCommit(tx, async () => {
    await publish(ctx.companyId, "artwork.rendered", { orderItemId: itemId, status: out.status });
  });
  return { clean: out.status === "rendered", artwork };
}

/**
 * Render (or re-render) the personalized artwork of one order item from its current values
 * (or the buyer's answers the first time). Stores item_artwork, mirrors status/flags onto the
 * item and returns whether the artwork is clean. State transitions are the caller's job.
 * Interactive, one item: imports and mappings use `requestItemRender` + the render job instead.
 */
export async function renderItemArtwork(
  tx: Tx,
  ctx: TenantContext,
  itemId: string,
  opts: { templateId?: string; values?: Record<string, string> } = {},
): Promise<{ clean: boolean; artwork: ArtworkRow }> {
  const plan = await planItemRender(tx, itemId, opts);
  const out = await renderValues(
    plan.template,
    plan.values,
    objectKey(ctx.companyId, "artwork", "png"),
  );
  return saveItemRender(tx, ctx, plan, out);
}

/* ----------------------------- render in the background ----------------------------- */

/**
 * Queue a render for a newly mapped personalized item (B-61): the artwork row goes `pending`
 * with the values to render, the item's artwork status goes `pending` (batches skip it), and
 * nothing calls imaging here. The caller emits `artwork.render_requested` in the same
 * transaction; `personalization.renderArtwork` renders after commit.
 */
export async function requestItemRender(
  tx: Tx,
  ctx: TenantContext,
  itemId: string,
  opts: { templateId?: string } = {},
) {
  const plan = await planItemRender(tx, itemId, opts);
  const set = {
    templateId: plan.templateId,
    values: plan.values,
    flags: [],
    status: "pending" as const,
    error: null,
    approvedBy: null,
    approvedAt: null,
  };
  if (plan.existing)
    await tx.update(itemArtwork).set(set).where(eq(itemArtwork.id, plan.existing.id));
  else
    await tx.insert(itemArtwork).values({ companyId: ctx.companyId, orderItemId: itemId, ...set });
  await tx
    .update(orderItems)
    .set({
      artworkStatus: "pending",
      flags: withFlags(plan.item.flags, [], ARTWORK_ITEM_FLAGS),
    })
    .where(eq(orderItems.id, itemId));
}

/** States in which a queued render still applies (the unit isn't on a sheet or gone). */
const RENDERABLE = new Set(["imported", "ready", "needs_artwork", "on_hold"]);

export type BackgroundRender = "rendered" | "flagged" | "failed" | "retry" | "skipped";

/**
 * Worker side of a queued render, one item. Reads in one short transaction, calls imaging with
 * none open, then saves under a row lock only if the artwork is still the `pending` render it
 * read (a staff edit or a second run in between wins; the repeat is `skipped`). A transient
 * failure returns `retry` without saving unless `final`; then it is saved as failed, the item
 * is flagged `artwork_qa_failed` with the reason and moves to `needs_artwork`.
 */
export async function renderPendingItem(
  ctx: TenantContext,
  itemId: string,
  final: boolean,
): Promise<BackgroundRender> {
  const plan = await withTenant(ctx.companyId, async (tx) => {
    const [a] = await tx
      .select()
      .from(itemArtwork)
      .where(eq(itemArtwork.orderItemId, itemId))
      .limit(1);
    if (a?.status !== "pending") return null;
    const p = await planItemRender(tx, itemId, { templateId: a.templateId, values: a.values });
    return RENDERABLE.has(p.item.state) ? p : null;
  });
  if (!plan) return "skipped";
  const out = await renderValues(
    plan.template,
    plan.values,
    objectKey(ctx.companyId, "artwork", "png"),
  );
  if (out.status === "failed" && out.transient && !final) return "retry";
  return withTenant(ctx.companyId, async (tx) => {
    const [item] = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.id, itemId))
      .for("update");
    const [a] = await tx
      .select()
      .from(itemArtwork)
      .where(eq(itemArtwork.orderItemId, itemId))
      .limit(1);
    if (
      !item ||
      !RENDERABLE.has(item.state) ||
      a?.status !== "pending" ||
      a.templateId !== plan.templateId ||
      JSON.stringify(a.values) !== JSON.stringify(plan.values)
    )
      return "skipped";
    const { clean } = await saveItemRender(tx, ctx, { ...plan, item, existing: a }, out);
    await settleItemState(
      tx,
      ctx,
      itemId,
      clean,
      clean ? "artwork_rendered" : out.status === "failed" ? "artwork_failed" : "artwork_flagged",
    );
    return out.status;
  });
}

/** Move the item between ready and needs_artwork to match its artwork. */
async function settleItemState(
  tx: Tx,
  ctx: TenantContext,
  itemId: string,
  clean: boolean,
  reason: string,
) {
  const [item] = await tx
    .select({ state: orderItems.state })
    .from(orderItems)
    .where(eq(orderItems.id, itemId))
    .limit(1);
  if (!item) return;
  if (clean && item.state === "needs_artwork")
    await transitionItem(tx, itemId, "ready", { actor: ctx.actor, reason });
  if (!clean && item.state === "ready")
    await transitionItem(tx, itemId, "needs_artwork", { actor: ctx.actor, reason });
}

type ArtworkJoin = {
  a: ArtworkRow;
  orderId: string;
  orderNo: string;
  shipBy: Date;
  designId: string | null;
  designName: string | null;
  personalization: PersonalizationAnswer[];
};

function toItemArtwork(r: ArtworkJoin): ItemArtwork {
  return {
    orderItemId: r.a.orderItemId,
    orderId: r.orderId,
    orderNo: r.orderNo,
    shipBy: r.shipBy.toISOString(),
    designId: r.designId ?? r.a.templateId,
    designName: r.designName ?? "",
    templateId: r.a.templateId,
    status: r.a.status,
    values: r.a.values,
    rawAnswers: r.personalization.map((p) => ({ question: p.question, answer: p.answer })),
    fileKey: r.a.fileKey,
    previewKey: r.a.previewKey,
    flags: r.a.flags as ItemArtwork["flags"],
    approvedBy: r.a.approvedBy,
    approvedAt: r.a.approvedAt?.toISOString() ?? null,
    renderedAt: r.a.renderedAt?.toISOString() ?? null,
    error: r.a.error,
  };
}

const artworkSelect = {
  a: itemArtwork,
  orderId: orders.id,
  orderNo: orders.orderNo,
  shipBy: orderItems.shipBy,
  designId: orderItems.designId,
  designName: designs.name,
  personalization: orderItems.personalization,
};

function artworkQuery(tx: Tx) {
  return tx
    .select(artworkSelect)
    .from(itemArtwork)
    .innerJoin(orderItems, eq(orderItems.id, itemArtwork.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .leftJoin(designs, eq(designs.id, orderItems.designId));
}

const STATUS_RANK = sql`case ${itemArtwork.status} when 'flagged' then 0 when 'failed' then 1 when 'pending' then 2 when 'rendered' then 3 else 4 end`;

export async function listArtwork(
  tx: Tx,
  _ctx: TenantContext,
  input: PageInput & {
    status?: ArtworkRow["status"][];
    shipByTo?: string;
    designId?: string;
    search?: string;
  },
) {
  const filters: (SQL | undefined)[] = [sql`${orderItems.state} <> 'cancelled'`];
  if (input.status?.length) filters.push(inArray(itemArtwork.status, input.status));
  if (input.shipByTo) filters.push(lte(orderItems.shipBy, new Date(input.shipByTo)));
  if (input.designId) filters.push(eq(orderItems.designId, input.designId));
  if (input.search)
    filters.push(
      or(
        ilike(orders.orderNo, `%${input.search}%`),
        sql`${itemArtwork.values}::text ilike ${`%${input.search}%`}`,
      ),
    );
  const offset = input.cursor ? Number(Buffer.from(input.cursor, "base64url").toString()) || 0 : 0;
  const rows = await artworkQuery(tx)
    .where(and(...filters))
    .orderBy(STATUS_RANK, orderItems.shipBy, itemArtwork.id)
    .limit(input.limit + 1)
    .offset(offset);
  const countRows = await tx
    .select({ status: itemArtwork.status, n: sql<number>`count(*)`.mapWith(Number) })
    .from(itemArtwork)
    .innerJoin(orderItems, eq(orderItems.id, itemArtwork.orderItemId))
    .where(sql`${orderItems.state} <> 'cancelled'`)
    .groupBy(itemArtwork.status);
  const counts = { pending: 0, rendered: 0, flagged: 0, approved: 0, failed: 0, purged: 0 };
  for (const c of countRows) counts[c.status] = c.n;
  return {
    items: rows.slice(0, input.limit).map(toItemArtwork),
    nextCursor:
      rows.length > input.limit
        ? Buffer.from(String(offset + input.limit)).toString("base64url")
        : null,
    counts,
  };
}

export async function getArtwork(
  tx: Tx,
  _ctx: TenantContext,
  orderItemId: string,
): Promise<ItemArtwork> {
  const [row] = await artworkQuery(tx).where(eq(itemArtwork.orderItemId, orderItemId)).limit(1);
  if (!row) throw notFound("item_artwork", orderItemId);
  return toItemArtwork(row);
}

export async function approveArtwork(tx: Tx, ctx: TenantContext, orderItemId: string) {
  const [a] = await tx
    .select()
    .from(itemArtwork)
    .where(eq(itemArtwork.orderItemId, orderItemId))
    .limit(1);
  if (!a) throw notFound("item_artwork", orderItemId);
  // Purged on a retention clock: the text is gone, so there is nothing to approve. `update`
  // with new values (a re-render) is the way back in.
  if (a.status === "purged" || !a.fileKey)
    throw conflict("There is no rendered artwork to approve; re-render first");
  const now = new Date();
  await tx
    .update(itemArtwork)
    .set({ status: "approved", approvedBy: ctx.userId, approvedAt: now })
    .where(eq(itemArtwork.id, a.id));
  const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, orderItemId)).limit(1);
  if (item) {
    await tx
      .update(orderItems)
      .set({
        artworkStatus: "approved",
        artworkKey: a.fileKey,
        flags: withFlags(item.flags, [], ARTWORK_ITEM_FLAGS),
      })
      .where(eq(orderItems.id, orderItemId));
  }
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "artwork.approved",
    entityType: "order_item",
    entityId: orderItemId,
    summary: a.flags.length
      ? `Artwork approved despite ${a.flags.length} flag(s)`
      : "Artwork approved",
    data: { orderId: item?.orderId ?? null },
  });
  if (ctx.userId)
    await emit(tx, ctx.companyId, "artwork.approved", { orderItemId, userId: ctx.userId });
  await settleItemState(tx, ctx, orderItemId, true, "artwork_approved");
  return getArtwork(tx, ctx, orderItemId);
}

export async function updateArtworkValues(
  tx: Tx,
  ctx: TenantContext,
  input: { orderItemId: string; values: Record<string, string>; approve: boolean },
) {
  const [a] = await tx
    .select()
    .from(itemArtwork)
    .where(eq(itemArtwork.orderItemId, input.orderItemId))
    .limit(1);
  if (!a) throw notFound("item_artwork", input.orderItemId);
  const values = { ...a.values, ...input.values };
  const { clean } = await renderItemArtwork(tx, ctx, input.orderItemId, {
    templateId: a.templateId,
    values,
  });
  if (input.approve) return approveArtwork(tx, ctx, input.orderItemId);
  await settleItemState(tx, ctx, input.orderItemId, clean, "artwork_edited");
  return getArtwork(tx, ctx, input.orderItemId);
}

export async function rerenderArtwork(tx: Tx, ctx: TenantContext, orderItemId: string) {
  const [a] = await tx
    .select()
    .from(itemArtwork)
    .where(eq(itemArtwork.orderItemId, orderItemId))
    .limit(1);
  const { clean } = await renderItemArtwork(
    tx,
    ctx,
    orderItemId,
    a ? { templateId: a.templateId, values: a.values } : {},
  );
  await settleItemState(tx, ctx, orderItemId, clean, "artwork_rerendered");
  return getArtwork(tx, ctx, orderItemId);
}

/** The template id for a design, or null when the design is not personalized. */
export async function templateForDesign(tx: Tx, designId: string): Promise<string | null> {
  const [d] = await tx
    .select({ t: designs.personalizationTemplateId })
    .from(designs)
    .where(eq(designs.id, designId))
    .limit(1);
  return d?.t ?? null;
}
