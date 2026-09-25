import {
  type Channel,
  SKU_TEMPLATE_FIELDS,
  type SkuRule,
  type SkuRuleInput as SkuRuleInputSchema,
  type SkuRuleTarget as SkuRuleTargetSchema,
  type SkuSuggestion,
} from "@invai/contracts";
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import {
  blankVariants,
  designs,
  listings,
  listingVariants,
  orderItems,
  orders,
  products,
  skuRules,
} from "../../db/schema";
import { audit } from "../../lib/audit";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";

/*
 * SKU mapper: channel SKU -> design + blank variant.
 *  - exact rules name both ids (`direct` target) and always win,
 *  - template rules (`{design}-{style}-{color}-{size}`) and regex rules (named groups) capture
 *    fields that resolve by code against the catalog (`resolve` target, with fixed defaults),
 *  - higher priority wins among patterns; channel/connection-specific rules beat global ones.
 */

type SkuRuleInput = z.infer<typeof SkuRuleInputSchema>;
type SkuRuleTarget = z.infer<typeof SkuRuleTargetSchema>;
export type SkuField = (typeof SKU_TEMPLATE_FIELDS)[number];
type RuleRow = typeof skuRules.$inferSelect;

/* ------------------------------------ patterns ------------------------------------ */

const FIELD_SET = new Set<string>(SKU_TEMPLATE_FIELDS);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compile a template like `{design}-{style}-{color}-{size}` into an anchored, case-insensitive regex. */
export function compileTemplate(template: string): RegExp {
  const parts = template.split(/(\{[a-z]+\})/g).filter((p) => p !== "");
  let re = "^";
  const seen = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const m = /^\{([a-z]+)\}$/.exec(part);
    if (!m) {
      re += escapeRe(part);
      continue;
    }
    const field = m[1] as string;
    if (!FIELD_SET.has(field) && field !== "any")
      throw badRequest(
        `Unknown template field {${field}}; use ${SKU_TEMPLATE_FIELDS.join(", ")} or {any}`,
      );
    if (field !== "any" && seen.has(field))
      throw badRequest(`Template field {${field}} appears twice`);
    seen.add(field);
    // A field stops at the next literal separator when there is one, else it is lazy.
    const next = parts[i + 1];
    const stop = next && !next.startsWith("{") ? next[0] : null;
    const body = stop ? `[^${escapeRe(stop)}]+` : ".+?";
    re += field === "any" ? `(?:${body})` : `(?<${field}>${body})`;
  }
  return new RegExp(`${re}$`, "i");
}

/*
 * Regex rules are user input run in shared processes, so they are bounded against
 * catastrophic backtracking (ReDoS): short patterns, no backreferences or lookarounds, no
 * quantified group that itself contains a quantifier or an alternation (`(a+)+`, `(a|a)*`), and
 * SKUs longer than MAX_SKU_MATCH_LEN are never run through a pattern.
 */
export const MAX_PATTERN_LEN = 200;
export const MAX_SKU_MATCH_LEN = 128;

/** Why a regex source is unsafe to run on user data, or null when it is fine. */
export function unsafeRegexReason(source: string): string | null {
  if (source.length > MAX_PATTERN_LEN) return `longer than ${MAX_PATTERN_LEN} characters`;
  if (/\\[1-9]|\\k</.test(source)) return "backreferences are not allowed";
  if (/\(\?<?[=!]/.test(source)) return "lookarounds are not allowed";
  // Per open group: does it contain a quantifier or `|`? A quantifier right after its `)` nests.
  const stack: { risky: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "(") stack.push({ risky: false });
    else if (ch === ")") {
      const group = stack.pop();
      const next = source[i + 1];
      const quantified = next === "+" || next === "*" || next === "{";
      if (group?.risky && quantified) return "nested quantifiers are not allowed";
      if (group?.risky && stack.length)
        (stack[stack.length - 1] as { risky: boolean }).risky = true;
    } else if (ch === "+" || ch === "*" || ch === "{" || ch === "|") {
      const top = stack[stack.length - 1];
      if (top) top.risky = true;
    }
  }
  return null;
}

/** Run a rule pattern against a SKU, refusing SKUs long enough to make backtracking costly. */
export function execSku(re: RegExp | null | undefined, sku: string): RegExpExecArray | null {
  const s = sku.trim();
  if (!re || s.length > MAX_SKU_MATCH_LEN) return null;
  return re.exec(s);
}

export function compilePattern(
  patternType: RuleRow["patternType"],
  pattern: string,
): RegExp | null {
  if (patternType === "exact") return null;
  if (patternType === "template") {
    if (pattern.length > MAX_PATTERN_LEN)
      throw badRequest(`Template is longer than ${MAX_PATTERN_LEN} characters`);
    return compileTemplate(pattern);
  }
  const unsafe = unsafeRegexReason(pattern);
  if (unsafe) throw badRequest(`Regex not allowed: ${unsafe}`);
  try {
    const re = new RegExp(pattern, "i");
    return re;
  } catch (err) {
    throw badRequest(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Fields captured by a pattern (lowercased keys limited to the template fields). */
export function captureFields(
  patternType: RuleRow["patternType"],
  pattern: string,
  sku: string,
): Partial<Record<SkuField, string>> | null {
  if (patternType === "exact")
    return sku.trim().toLowerCase() === pattern.trim().toLowerCase() ? {} : null;
  const re = compilePattern(patternType, pattern);
  const m = execSku(re, sku);
  if (!m) return null;
  const out: Partial<Record<SkuField, string>> = {};
  for (const [k, v] of Object.entries(m.groups ?? {})) {
    if (FIELD_SET.has(k) && v !== undefined) out[k as SkuField] = v;
  }
  return out;
}

/* ------------------------------------ catalog index ------------------------------------ */

type BlankLite = Pick<
  typeof blankVariants.$inferSelect,
  "id" | "brand" | "style" | "styleCode" | "color" | "colorCode" | "size" | "sizeCode" | "sku"
>;
type DesignLite = { id: string; code: string; name: string };

export type CatalogIndex = {
  designs: DesignLite[];
  designByKey: Map<string, DesignLite>;
  blanks: BlankLite[];
};

export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function loadCatalogIndex(tx: Tx): Promise<CatalogIndex> {
  const ds = await tx
    .select({ id: designs.id, code: designs.code, name: designs.name })
    .from(designs)
    .where(eq(designs.status, "active"));
  const bs = await tx
    .select({
      id: blankVariants.id,
      brand: blankVariants.brand,
      style: blankVariants.style,
      styleCode: blankVariants.styleCode,
      color: blankVariants.color,
      colorCode: blankVariants.colorCode,
      size: blankVariants.size,
      sizeCode: blankVariants.sizeCode,
      sku: blankVariants.sku,
    })
    .from(blankVariants)
    .where(eq(blankVariants.status, "active"));
  const designByKey = new Map<string, DesignLite>();
  for (const d of ds) {
    designByKey.set(norm(d.code), d);
    if (!designByKey.has(norm(d.name))) designByKey.set(norm(d.name), d);
  }
  return { designs: ds, designByKey, blanks: bs };
}

const eqAny = (v: string | undefined, ...candidates: string[]) =>
  v === undefined || candidates.some((c) => norm(c) === norm(v));

export type Resolution =
  | { ok: true; designId: string; blankVariantId: string }
  | { ok: false; error: string };

export function resolveFields(
  index: CatalogIndex,
  fields: Partial<Record<SkuField, string>>,
): Resolution {
  const d = fields.design;
  if (!d) return { ok: false, error: "No design captured" };
  const design = index.designByKey.get(norm(d));
  if (!design) return { ok: false, error: `Unknown design "${d}"` };
  if (!fields.style && !fields.color && !fields.size)
    return { ok: false, error: "No blank fields captured" };
  const candidates = index.blanks.filter(
    (b) =>
      eqAny(fields.style, b.styleCode, b.style) &&
      eqAny(fields.color, b.colorCode, b.color) &&
      eqAny(fields.size, b.sizeCode, b.size) &&
      eqAny(fields.brand, b.brand),
  );
  if (candidates.length === 0)
    return {
      ok: false,
      error: `No blank for ${[fields.brand, fields.style, fields.color, fields.size].filter(Boolean).join(" / ")}`,
    };
  if (candidates.length > 1)
    return {
      ok: false,
      error: `${candidates.length} blanks match; add style or brand to the rule`,
    };
  return { ok: true, designId: design.id, blankVariantId: (candidates[0] as BlankLite).id };
}

/* ------------------------------------ matching ------------------------------------ */

export type MatchContext = { channel: Channel; connectionId: string | null };
export type SkuMatch = {
  designId: string;
  blankVariantId: string;
  ruleId: string;
  fields: Partial<Record<SkuField, string>>;
};

export type Matcher = {
  match(sku: string, scope: MatchContext): SkuMatch | null;
  /** Rule ids used since creation (for matchCount bookkeeping). */
  used: Map<string, number>;
};

export function rankRules(rules: RuleRow[]): RuleRow[] {
  const score = (r: RuleRow) => (r.connectionId ? 2 : 0) + (r.channel ? 1 : 0);
  return rules
    .filter((r) => r.active)
    .sort(
      (a, b) =>
        Number(b.patternType === "exact") - Number(a.patternType === "exact") ||
        b.priority - a.priority ||
        score(b) - score(a) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
}

export function buildMatcher(rules: RuleRow[], index: CatalogIndex): Matcher {
  const ranked = rankRules(rules);
  const compiled = new Map<string, RegExp | null>();
  for (const r of ranked) {
    try {
      compiled.set(r.id, compilePattern(r.patternType, r.pattern));
    } catch {
      compiled.set(r.id, null);
    }
  }
  const used = new Map<string, number>();
  return {
    used,
    match(sku, scope) {
      if (!sku.trim()) return null;
      for (const r of ranked) {
        if (r.channel && r.channel !== scope.channel) continue;
        if (r.connectionId && r.connectionId !== scope.connectionId) continue;
        let fields: Partial<Record<SkuField, string>> | null;
        if (r.patternType === "exact") {
          fields = sku.trim().toLowerCase() === r.pattern.trim().toLowerCase() ? {} : null;
        } else {
          const m = execSku(compiled.get(r.id), sku);
          fields = m
            ? (Object.fromEntries(
                Object.entries(m.groups ?? {}).filter(([k]) => FIELD_SET.has(k)),
              ) as Partial<Record<SkuField, string>>)
            : null;
        }
        if (!fields) continue;
        const target = r.target as SkuRuleTarget;
        if (target.kind === "direct") {
          used.set(r.id, (used.get(r.id) ?? 0) + 1);
          return {
            designId: target.designId,
            blankVariantId: target.blankVariantId,
            ruleId: r.id,
            fields,
          };
        }
        const res = resolveFields(index, { ...(target.defaults ?? {}), ...fields });
        if (res.ok) {
          used.set(r.id, (used.get(r.id) ?? 0) + 1);
          return {
            designId: res.designId,
            blankVariantId: res.blankVariantId,
            ruleId: r.id,
            fields,
          };
        }
      }
      return null;
    },
  };
}

export async function loadMatcher(tx: Tx): Promise<Matcher> {
  const [rules, index] = await Promise.all([
    tx.select().from(skuRules).where(eq(skuRules.active, true)),
    loadCatalogIndex(tx),
  ]);
  return buildMatcher(rules, index);
}

/** Persist match counters collected by a matcher. */
export async function recordRuleUse(tx: Tx, matcher: Matcher) {
  const now = new Date();
  for (const [id, n] of matcher.used) {
    await tx
      .update(skuRules)
      .set({ matchCount: sql`${skuRules.matchCount} + ${n}`, lastMatchedAt: now })
      .where(eq(skuRules.id, id));
  }
  matcher.used.clear();
}

/* ------------------------------------ rules CRUD ------------------------------------ */

export function toSkuRule(r: RuleRow): SkuRule {
  return {
    id: r.id,
    name: r.name,
    patternType: r.patternType,
    pattern: r.pattern,
    channel: r.channel,
    connectionId: r.connectionId,
    target: r.target as SkuRule["target"],
    priority: r.priority,
    active: r.active,
    source: r.source,
    matchCount: r.matchCount,
    lastMatchedAt: r.lastMatchedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The listing SKUs a rule can touch: exact rules name one; patterns may match any. */
const ruleScope = (r: Pick<RuleRow, "patternType" | "pattern">) =>
  r.patternType === "exact" ? { skus: [r.pattern] } : {};

function validateRule(input: Pick<SkuRuleInput, "patternType" | "pattern" | "target">) {
  compilePattern(input.patternType, input.pattern);
  if (input.patternType === "exact" && input.target.kind !== "direct")
    throw badRequest("Exact rules need a direct target (designId + blankVariantId)");
  if (input.patternType !== "exact" && input.target.kind === "direct") return;
  if (input.patternType === "regex" && input.target.kind === "resolve") {
    const re = compilePattern("regex", input.pattern) as RegExp;
    const groups = [...re.source.matchAll(/\(\?<([a-zA-Z]+)>/g)].map((m) => m[1]);
    if (!groups.includes("design") && !input.target.defaults.design)
      throw badRequest("A resolving regex needs a (?<design>...) group or a design default");
  }
}

export async function listRules(
  tx: Tx,
  _ctx: TenantContext,
  input: PageInput & {
    channel?: Channel;
    patternType?: RuleRow["patternType"];
    search?: string;
    active?: boolean;
  },
) {
  const page = keyset(skuRules.createdAt, skuRules.id, input);
  const filters: (SQL | undefined)[] = [page.where];
  if (input.channel) filters.push(eq(skuRules.channel, input.channel));
  if (input.patternType) filters.push(eq(skuRules.patternType, input.patternType));
  if (input.active !== undefined) filters.push(eq(skuRules.active, input.active));
  if (input.search)
    filters.push(
      or(ilike(skuRules.pattern, `%${input.search}%`), ilike(skuRules.name, `%${input.search}%`)),
    );
  const rows = await tx
    .select()
    .from(skuRules)
    .where(and(...filters))
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  return page.result(rows, toSkuRule);
}

export async function getRule(tx: Tx, _ctx: TenantContext, id: string) {
  const [row] = await tx.select().from(skuRules).where(eq(skuRules.id, id)).limit(1);
  if (!row) throw notFound("sku_rule", id);
  return toSkuRule(row);
}

export async function createRule(
  tx: Tx,
  ctx: TenantContext,
  input: SkuRuleInput,
  source: RuleRow["source"] = "manual",
): Promise<SkuRule> {
  validateRule(input);
  const [dup] = await tx
    .select()
    .from(skuRules)
    .where(
      and(
        sql`lower(${skuRules.pattern}) = lower(${input.pattern})`,
        input.channel ? eq(skuRules.channel, input.channel) : sql`${skuRules.channel} is null`,
        input.connectionId
          ? eq(skuRules.connectionId, input.connectionId)
          : sql`${skuRules.connectionId} is null`,
      ),
    )
    .limit(1);
  let row: RuleRow | undefined;
  if (dup) {
    if (source === "manual")
      throw conflict(`A rule for "${input.pattern}" already exists`, { ruleId: dup.id });
    // Learning the same SKU again replaces the old target (the latest manual map wins).
    [row] = await tx
      .update(skuRules)
      .set({ target: input.target, active: true, priority: Math.max(dup.priority, input.priority) })
      .where(eq(skuRules.id, dup.id))
      .returning();
  } else {
    [row] = await tx
      .insert(skuRules)
      .values({
        companyId: ctx.companyId,
        name: input.name,
        patternType: input.patternType,
        pattern: input.pattern,
        channel: input.channel,
        connectionId: input.connectionId,
        target: input.target,
        priority: input.priority,
        active: input.active,
        source,
      })
      .returning();
  }
  if (!row) throw new Error("sku rule insert failed");
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "sku_rule.saved",
    entityType: "sku_rule",
    entityId: row.id,
    summary: `SKU rule ${row.patternType} "${row.pattern}" saved`,
  });
  if (source === "learned")
    await emit(tx, ctx.companyId, "sku_rule.learned", { ruleId: row.id, channelSku: row.pattern });
  await refreshListingMappings(tx, ctx.companyId, ruleScope(row));
  return toSkuRule(row);
}

export async function updateRule(
  tx: Tx,
  ctx: TenantContext,
  input: Partial<SkuRuleInput> & { id: string },
) {
  const [row] = await tx.select().from(skuRules).where(eq(skuRules.id, input.id)).limit(1);
  if (!row) throw notFound("sku_rule", input.id);
  const next = {
    name: input.name === undefined ? row.name : input.name,
    patternType: input.patternType ?? row.patternType,
    pattern: input.pattern ?? row.pattern,
    channel: input.channel === undefined ? row.channel : input.channel,
    connectionId: input.connectionId === undefined ? row.connectionId : input.connectionId,
    target: (input.target ?? row.target) as SkuRuleTarget,
    priority: input.priority ?? row.priority,
    active: input.active ?? row.active,
  };
  validateRule(next);
  const [updated] = await tx
    .update(skuRules)
    .set(next)
    .where(eq(skuRules.id, input.id))
    .returning();
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "sku_rule.saved",
    entityType: "sku_rule",
    entityId: input.id,
    summary: `SKU rule "${next.pattern}" updated`,
  });
  await refreshListingMappings(tx, ctx.companyId, ruleScope(next));
  return toSkuRule(updated as RuleRow);
}

export async function deleteRule(tx: Tx, ctx: TenantContext, id: string) {
  const [row] = await tx.delete(skuRules).where(eq(skuRules.id, id)).returning();
  if (!row) throw notFound("sku_rule", id);
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "sku_rule.deleted",
    entityType: "sku_rule",
    entityId: id,
    summary: `SKU rule "${row.pattern}" deleted`,
  });
  return { ok: true as const };
}

/** Dry-run a pattern against a sample SKU. */
export async function testRule(
  tx: Tx,
  _ctx: TenantContext,
  input: {
    patternType: RuleRow["patternType"];
    pattern: string;
    target: SkuRuleTarget;
    sample: string;
  },
) {
  let fields: Partial<Record<SkuField, string>> | null;
  try {
    fields = captureFields(input.patternType, input.pattern, input.sample);
  } catch (err) {
    return {
      matched: false,
      fields: {},
      designId: null,
      blankVariantId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!fields)
    return {
      matched: false,
      fields: {},
      designId: null,
      blankVariantId: null,
      error: "Pattern does not match the sample",
    };
  if (input.target.kind === "direct")
    return {
      matched: true,
      fields,
      designId: input.target.designId,
      blankVariantId: input.target.blankVariantId,
      error: null,
    };
  const res = resolveFields(await loadCatalogIndex(tx), { ...input.target.defaults, ...fields });
  return res.ok
    ? {
        matched: true,
        fields,
        designId: res.designId,
        blankVariantId: res.blankVariantId,
        error: null,
      }
    : { matched: true, fields, designId: null, blankVariantId: null, error: res.error };
}

/* ------------------------------------ unmapped ------------------------------------ */

const encodeOffset = (n: number) => Buffer.from(`o:${n}`).toString("base64url");
const decodeOffset = (c?: string) => {
  if (!c) return 0;
  const raw = Buffer.from(c, "base64url").toString("utf8");
  const n = raw.startsWith("o:") ? Number(raw.slice(2)) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) throw badRequest("Invalid cursor");
  return n;
};

export async function unmapped(
  tx: Tx,
  _ctx: TenantContext,
  input: PageInput & { channel?: Channel; search?: string },
) {
  const filters: (SQL | undefined)[] = [eq(orderItems.state, "needs_mapping")];
  if (input.channel) filters.push(eq(orders.channel, input.channel));
  if (input.search)
    filters.push(
      or(
        ilike(orderItems.channelSku, `%${input.search}%`),
        ilike(orderItems.title, `%${input.search}%`),
      ),
    );
  const where = and(...filters);
  const offset = decodeOffset(input.cursor);
  const rows = await tx
    .select({
      channelSku: orderItems.channelSku,
      channel: orders.channel,
      connectionId: orders.connectionId,
      itemCount: sql<number>`count(*)`.mapWith(Number),
      orderCount: sql<number>`count(distinct ${orders.id})`.mapWith(Number),
      sampleTitle: sql<string | null>`max(${orderItems.title})`,
      sampleVariantTitle: sql<string | null>`max(${orderItems.variantTitle})`,
      earliestShipBy: sql<Date | null>`min(${orderItems.shipBy})`.mapWith(orderItems.shipBy),
      firstSeenAt: sql<Date>`min(${orderItems.createdAt})`.mapWith(orderItems.createdAt),
      lastSeenAt: sql<Date>`max(${orderItems.createdAt})`.mapWith(orderItems.createdAt),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(where)
    .groupBy(orderItems.channelSku, orders.channel, orders.connectionId)
    .orderBy(sql`min(${orderItems.shipBy})`, orderItems.channelSku)
    .limit(input.limit + 1)
    .offset(offset);
  const [totals] = await tx
    .select({
      skus: sql<number>`count(distinct (${orderItems.channelSku}, ${orders.connectionId}))`.mapWith(
        Number,
      ),
      items: sql<number>`count(*)`.mapWith(Number),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(where);
  const page = rows.slice(0, input.limit);
  return {
    items: page.map((r) => ({
      channelSku: r.channelSku,
      channel: r.channel,
      connectionId: r.connectionId,
      itemCount: r.itemCount,
      orderCount: r.orderCount,
      sampleTitle: r.sampleTitle,
      sampleVariantTitle: r.sampleVariantTitle,
      earliestShipBy: r.earliestShipBy ? new Date(r.earliestShipBy).toISOString() : null,
      firstSeenAt: new Date(r.firstSeenAt).toISOString(),
      lastSeenAt: new Date(r.lastSeenAt).toISOString(),
    })),
    nextCursor: rows.length > input.limit ? encodeOffset(offset + input.limit) : null,
    totalSkus: totals?.skus ?? 0,
    totalItems: totals?.items ?? 0,
  };
}

/* ------------------------------------ suggest ------------------------------------ */

const tokenize = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.trim())
    .filter(Boolean);

type Classified = { field: SkuField | null; value: string };

function classifyToken(index: CatalogIndex, token: string): SkuField | null {
  const t = norm(token);
  if (index.designByKey.has(t) && index.designs.some((d) => norm(d.code) === t)) return "design";
  if (index.blanks.some((b) => norm(b.sizeCode) === t || norm(b.size) === t)) return "size";
  if (index.blanks.some((b) => norm(b.colorCode) === t)) return "color";
  if (index.blanks.some((b) => norm(b.styleCode) === t || norm(b.style) === t)) return "style";
  if (index.blanks.some((b) => norm(b.brand) === t)) return "brand";
  return null;
}

/** A template that reproduces `sku` when every token classifies; null otherwise. */
function inferTemplate(sku: string, classified: Classified[]): string | null {
  if (classified.some((c) => c.field === null)) return null;
  const fields = classified.map((c) => c.field as SkuField);
  if (!fields.includes("design") || new Set(fields).size !== fields.length) return null;
  let template = sku;
  let offset = 0;
  for (const c of classified) {
    const at = template.indexOf(c.value, offset);
    if (at < 0) return null;
    const ph = `{${c.field}}`;
    template = template.slice(0, at) + ph + template.slice(at + c.value.length);
    offset = at + ph.length;
  }
  return template;
}

function findColor(index: CatalogIndex, text: string) {
  const t = ` ${text.toLowerCase()} `;
  const byLen = [...new Set(index.blanks.map((b) => b.color))].sort((a, b) => b.length - a.length);
  return byLen.find(
    (c) =>
      t.includes(` ${c.toLowerCase()} `) ||
      t.includes(`${c.toLowerCase()} /`) ||
      t.includes(`/ ${c.toLowerCase()}`),
  );
}

function findSize(index: CatalogIndex, text: string) {
  const tokens = tokenize(text).map((t) => t.toLowerCase());
  const sizes = [...new Set(index.blanks.map((b) => b.size))];
  const alias: Record<string, string> = {
    small: "s",
    medium: "m",
    large: "l",
    xxl: "2xl",
    xxxl: "3xl",
  };
  for (const tok of tokens.reverse()) {
    const t = alias[tok] ?? tok;
    const hit = sizes.find((s) => s.toLowerCase() === t);
    if (hit) return hit;
  }
  return undefined;
}

export async function suggest(
  tx: Tx,
  _ctx: TenantContext,
  input: { channelSkus: string[]; useAi: boolean },
) {
  const [matcher, index] = await Promise.all([loadMatcher(tx), loadCatalogIndex(tx)]);
  const samples = await tx
    .select({
      sku: orderItems.channelSku,
      title: sql<string>`max(${orderItems.title})`,
      variantTitle: sql<string | null>`max(${orderItems.variantTitle})`,
      channel: sql<Channel>`max(${orders.channel})`,
      connectionId: sql<string>`max(${orders.connectionId}::text)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(inArray(orderItems.channelSku, input.channelSkus))
    .groupBy(orderItems.channelSku);
  const sampleBy = new Map(samples.map((s) => [s.sku, s]));
  const unmappedSkus = await tx
    .selectDistinct({ sku: orderItems.channelSku })
    .from(orderItems)
    .where(eq(orderItems.state, "needs_mapping"));

  const items: SkuSuggestion[] = [];
  for (const sku of input.channelSkus) {
    const sample = sampleBy.get(sku);
    const hit = matcher.match(sku, {
      channel: sample?.channel ?? "csv",
      connectionId: sample?.connectionId ?? null,
    });
    if (hit) {
      items.push({
        channelSku: sku,
        designId: hit.designId,
        blankVariantId: hit.blankVariantId,
        rule: null,
        confidence: 1,
        source: "rule",
        explanation: "An existing SKU rule already maps this SKU",
      });
      continue;
    }

    const tokens = tokenize(sku);
    const classified: Classified[] = tokens.map((t) => ({
      value: t,
      field: classifyToken(index, t),
    }));
    const fields: Partial<Record<SkuField, string>> = {};
    for (const c of classified) if (c.field && !fields[c.field]) fields[c.field] = c.value;
    const reasons: string[] = [];
    let confidence = 0;
    let designId: string | null = null;

    if (fields.design) {
      designId = index.designByKey.get(norm(fields.design))?.id ?? null;
      confidence = 0.6;
      reasons.push(`design code ${fields.design} in the SKU`);
    } else if (sample?.title) {
      const [best] = await tx
        .select({
          id: designs.id,
          name: designs.name,
          sim: sql<number>`similarity(${designs.name}, ${sample.title})`.mapWith(Number),
        })
        .from(designs)
        .where(eq(designs.status, "active"))
        .orderBy(desc(sql`similarity(${designs.name}, ${sample.title})`))
        .limit(1);
      if (best && best.sim >= 0.25) {
        designId = best.id;
        confidence = Math.min(0.55, 0.2 + best.sim * 0.5);
        reasons.push(
          `title "${sample.title}" resembles design "${best.name}" (${Math.round(best.sim * 100)}%)`,
        );
      }
    }

    const text = `${sample?.variantTitle ?? ""} ${sample?.title ?? ""}`;
    if (!fields.color) {
      const color = findColor(index, text);
      if (color) {
        fields.color = color;
        reasons.push(`color ${color} from the listing`);
      }
    }
    if (!fields.size) {
      const size = findSize(index, `${sample?.variantTitle ?? ""} ${sku}`);
      if (size) {
        fields.size = size;
        reasons.push(`size ${size}`);
      }
    }
    if (!fields.style && designId) {
      const styles = await tx
        .selectDistinct({ styleCode: products.styleCode })
        .from(products)
        .where(and(eq(products.designId, designId), eq(products.status, "active")));
      if (styles.length === 1) {
        fields.style = styles[0]?.styleCode;
        reasons.push(`the design's only product style ${fields.style}`);
      }
    }

    let blankVariantId: string | null = null;
    if (designId) {
      const design = index.designs.find((d) => d.id === designId);
      const res = resolveFields(index, { ...fields, design: design?.code });
      if (res.ok) {
        blankVariantId = res.blankVariantId;
        confidence += 0.3;
      } else reasons.push(res.error);
    }

    let rule: SkuSuggestion["rule"] = null;
    const template = inferTemplate(sku, classified);
    if (template && blankVariantId) {
      const re = compileTemplate(template);
      const would = unmappedSkus.filter((u) => {
        const m = execSku(re, u.sku);
        return m && resolveFields(index, m.groups ?? {}).ok;
      }).length;
      rule = {
        patternType: "template",
        pattern: template,
        target: { kind: "resolve", defaults: {} },
        wouldMatchCount: would,
      };
      confidence += 0.05;
    } else if (designId && blankVariantId) {
      rule = {
        patternType: "exact",
        pattern: sku,
        target: { kind: "direct", designId, blankVariantId },
        wouldMatchCount: unmappedSkus.filter((u) => u.sku.toLowerCase() === sku.toLowerCase())
          .length,
      };
    }

    items.push({
      channelSku: sku,
      designId,
      blankVariantId,
      rule,
      confidence: Math.min(0.95, Math.round(confidence * 100) / 100),
      source: "heuristic",
      explanation: reasons.length
        ? `Matched ${reasons.join("; ")}`
        : "No design or blank could be inferred",
    });
  }
  // AI suggestions go through the AI gateway (ai module); the heuristic covers v1.
  return { items, creditsUsed: 0 };
}

/* ------------------------------------ listings ------------------------------------ */

/*
 * Channel listings as orders reveal them. Every imported or mapped unit names its listing
 * (`channelListingId`) and SKU; one `listings` row per (connection, listing id) and one
 * `listing_variants` row per SKU on it, carrying the design and blank the SKU maps to. The
 * availability push (inventory) reads these rows. Channels don't send a variant id with an order
 * line, so the SKU is the variant's identity on the listing.
 */

type ListingSource = {
  connectionId: string;
  channel: Channel;
  channelListingId: string | null;
  channelSku: string;
  title: string;
  variantTitle: string | null;
  designId: string | null;
  productId: string | null;
  blankVariantId: string | null;
  unitPriceCents: number;
};

export type RecordedListings = {
  listings: number;
  variants: number;
  /** Blanks whose listing variants are new or now map to them: their availability should push. */
  blankVariantIds: string[];
};

const listingSourceFields = {
  connectionId: orders.connectionId,
  channel: orders.channel,
  channelListingId: orderItems.channelListingId,
  channelSku: orderItems.channelSku,
  title: orderItems.title,
  variantTitle: orderItems.variantTitle,
  designId: orderItems.designId,
  productId: orderItems.productId,
  blankVariantId: orderItems.blankVariantId,
  unitPriceCents: orderItems.unitPriceCents,
};

/** Upsert the listings and listing variants of these order items (import and mapping). */
export async function recordListingsForItems(
  tx: Tx,
  companyId: string,
  orderItemIds: string[],
): Promise<RecordedListings> {
  if (!orderItemIds.length) return { listings: 0, variants: 0, blankVariantIds: [] };
  const rows = await tx
    .select(listingSourceFields)
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orderItems.companyId, companyId), inArray(orderItems.id, orderItemIds)))
    .orderBy(asc(orderItems.createdAt));
  return upsertListings(tx, companyId, rows);
}

/**
 * Backfill from every order the company has (the seed, or a shop that imported before listings
 * were recorded). Per listing SKU the latest mapped unit wins.
 */
export async function recordListingsForCompany(
  tx: Tx,
  companyId: string,
): Promise<RecordedListings> {
  const rows = await tx
    .selectDistinctOn(
      [orders.connectionId, orderItems.channelListingId, orderItems.channelSku],
      listingSourceFields,
    )
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orderItems.companyId, companyId),
        isNotNull(orderItems.channelListingId),
        sql`trim(${orderItems.channelSku}) <> ''`,
      ),
    )
    .orderBy(
      orders.connectionId,
      orderItems.channelListingId,
      orderItems.channelSku,
      sql`${orderItems.blankVariantId} is null`,
      desc(orderItems.createdAt),
    );
  // Oldest first, so the latest unit of each listing names it.
  return upsertListings(tx, companyId, rows.reverse());
}

async function upsertListings(
  tx: Tx,
  companyId: string,
  sources: ListingSource[],
): Promise<RecordedListings> {
  const usable = sources
    .map((s) => ({ ...s, channelSku: s.channelSku.trim() }))
    .filter((s) => s.channelListingId && s.channelSku !== "");
  if (!usable.length) return { listings: 0, variants: 0, blankVariantIds: [] };

  // One row per key: a single INSERT ... ON CONFLICT can't touch the same row twice.
  const listingKey = (s: { connectionId: string; channelListingId: string | null }) =>
    `${s.connectionId}|${s.channelListingId}`;
  const byListing = new Map<string, ListingSource>();
  for (const s of usable) {
    const prev = byListing.get(listingKey(s));
    byListing.set(listingKey(s), {
      ...s,
      designId: s.designId ?? prev?.designId ?? null,
      productId: s.productId ?? prev?.productId ?? null,
    });
  }
  const listingRows = await tx
    .insert(listings)
    .values(
      [...byListing.values()].map((s) => ({
        companyId,
        connectionId: s.connectionId,
        channel: s.channel,
        channelListingId: s.channelListingId as string,
        title: s.title,
        designId: s.designId,
        productId: s.productId,
      })),
    )
    .onConflictDoUpdate({
      target: [listings.companyId, listings.connectionId, listings.channelListingId],
      set: {
        title: sql`excluded.title`,
        designId: sql`coalesce(excluded.design_id, ${listings.designId})`,
        productId: sql`coalesce(excluded.product_id, ${listings.productId})`,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: listings.id,
      connectionId: listings.connectionId,
      channelListingId: listings.channelListingId,
    });
  const listingIdOf = new Map(listingRows.map((l) => [listingKey(l), l.id]));

  const variantKey = (listingId: string, sku: string) => `${listingId}|${sku}`;
  const byVariant = new Map<string, ListingSource & { listingId: string }>();
  for (const s of usable) {
    const listingId = listingIdOf.get(listingKey(s));
    if (!listingId) continue;
    const k = variantKey(listingId, s.channelSku);
    const prev = byVariant.get(k);
    byVariant.set(k, {
      ...s,
      listingId,
      designId: s.designId ?? prev?.designId ?? null,
      blankVariantId: s.blankVariantId ?? prev?.blankVariantId ?? null,
    });
  }
  const variants = [...byVariant.values()];
  const before = await tx
    .select({
      listingId: listingVariants.listingId,
      channelVariantId: listingVariants.channelVariantId,
      blankVariantId: listingVariants.blankVariantId,
    })
    .from(listingVariants)
    .where(
      and(
        eq(listingVariants.companyId, companyId),
        inArray(listingVariants.listingId, [...new Set(variants.map((v) => v.listingId))]),
      ),
    );
  const blankBefore = new Map(
    before.map((b) => [variantKey(b.listingId, b.channelVariantId), b.blankVariantId]),
  );
  await tx
    .insert(listingVariants)
    .values(
      variants.map((v) => ({
        companyId,
        listingId: v.listingId,
        channelVariantId: v.channelSku,
        channelSku: v.channelSku,
        title: v.variantTitle,
        designId: v.designId,
        blankVariantId: v.blankVariantId,
        priceCents: v.unitPriceCents,
      })),
    )
    .onConflictDoUpdate({
      target: [
        listingVariants.companyId,
        listingVariants.listingId,
        listingVariants.channelVariantId,
      ],
      set: {
        title: sql`coalesce(excluded.title, ${listingVariants.title})`,
        designId: sql`coalesce(excluded.design_id, ${listingVariants.designId})`,
        blankVariantId: sql`coalesce(excluded.blank_variant_id, ${listingVariants.blankVariantId})`,
        priceCents: sql`coalesce(excluded.price_cents, ${listingVariants.priceCents})`,
        updatedAt: new Date(),
      },
    });

  const changed = new Set<string>();
  for (const v of variants) {
    if (
      v.blankVariantId &&
      blankBefore.get(variantKey(v.listingId, v.channelSku)) !== v.blankVariantId
    )
      changed.add(v.blankVariantId);
  }
  return { listings: listingRows.length, variants: variants.length, blankVariantIds: [...changed] };
}

/**
 * After a SKU rule is saved: point the listing variants it matches at the rule's design and
 * blank (rules are what future imports map by, so the listing follows them). Variants no rule
 * matches keep the mapping their orders gave them. `skus` narrows the scan (exact rules).
 */
export async function refreshListingMappings(
  tx: Tx,
  companyId: string,
  opts: { skus?: string[] } = {},
): Promise<string[]> {
  const filters: (SQL | undefined)[] = [
    eq(listingVariants.companyId, companyId),
    isNotNull(listingVariants.channelSku),
  ];
  if (opts.skus) {
    if (!opts.skus.length) return [];
    filters.push(
      inArray(
        sql`lower(${listingVariants.channelSku})`,
        opts.skus.map((s) => s.trim().toLowerCase()),
      ),
    );
  }
  const rows = await tx
    .select({
      id: listingVariants.id,
      channelSku: listingVariants.channelSku,
      designId: listingVariants.designId,
      blankVariantId: listingVariants.blankVariantId,
      channel: listings.channel,
      connectionId: listings.connectionId,
    })
    .from(listingVariants)
    .innerJoin(listings, eq(listings.id, listingVariants.listingId))
    .where(and(...filters));
  if (!rows.length) return [];
  // A private matcher: listing refreshes don't count as rule matches.
  const matcher = await loadMatcher(tx);
  const changed = new Set<string>();
  for (const r of rows) {
    const hit = matcher.match(r.channelSku as string, {
      channel: r.channel,
      connectionId: r.connectionId,
    });
    if (!hit || (hit.blankVariantId === r.blankVariantId && hit.designId === r.designId)) continue;
    await tx
      .update(listingVariants)
      .set({ designId: hit.designId, blankVariantId: hit.blankVariantId, updatedAt: new Date() })
      .where(eq(listingVariants.id, r.id));
    changed.add(hit.blankVariantId);
  }
  if (changed.size)
    await emit(tx, companyId, "stock.availability_changed", { blankVariantIds: [...changed] });
  return [...changed];
}

export type PushTarget = {
  listingVariantId: string;
  connectionId: string;
  channelSku: string;
  blankVariantId: string;
  quantityCap: number | null;
  lastPushedQty: number | null;
};

/** Listing variants that can carry availability: they have a SKU and map to a blank. */
export async function listPushTargets(tx: Tx, companyId: string): Promise<PushTarget[]> {
  const rows = await tx
    .select({
      listingVariantId: listingVariants.id,
      connectionId: listings.connectionId,
      channelSku: listingVariants.channelSku,
      blankVariantId: listingVariants.blankVariantId,
      quantityCap: listingVariants.quantityCap,
      lastPushedQty: listingVariants.lastPushedQty,
    })
    .from(listingVariants)
    .innerJoin(listings, eq(listings.id, listingVariants.listingId))
    .where(
      and(
        eq(listingVariants.companyId, companyId),
        isNotNull(listingVariants.blankVariantId),
        isNotNull(listingVariants.channelSku),
        sql`trim(${listingVariants.channelSku}) <> ''`,
      ),
    );
  return rows as PushTarget[];
}

/** The quantity last pushed per listing variant (null: never pushed). */
export async function lastPushedQuantities(
  tx: Tx,
  companyId: string,
  listingVariantIds: string[],
): Promise<Map<string, number | null>> {
  if (!listingVariantIds.length) return new Map();
  const rows = await tx
    .select({ id: listingVariants.id, qty: listingVariants.lastPushedQty })
    .from(listingVariants)
    .where(
      and(eq(listingVariants.companyId, companyId), inArray(listingVariants.id, listingVariantIds)),
    );
  return new Map(rows.map((r) => [r.id, r.qty]));
}

/** Record what the channel now holds, so an unchanged quantity isn't pushed again. */
export async function markAvailabilityPushed(
  tx: Tx,
  companyId: string,
  pushed: { listingVariantId: string; available: number }[],
): Promise<void> {
  for (const p of pushed) {
    await tx
      .update(listingVariants)
      .set({ lastPushedQty: p.available, updatedAt: new Date() })
      .where(
        and(eq(listingVariants.companyId, companyId), eq(listingVariants.id, p.listingVariantId)),
      );
  }
}
