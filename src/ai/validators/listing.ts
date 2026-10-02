import {
  CHANNEL_RULES,
  type Channel,
  type ListingContent,
  type ValidationResult,
} from "@invai/contracts";

/*
 * Deterministic channel-rule validation (architecture 8.1): the model's structured output is
 * checked against the hard limits in contracts CHANNEL_RULES (Etsy 140-character title, 13 tags of
 * at most 20 characters, Amazon 5 bullets...). The gateway retries once with these errors attached.
 */

type Issue = ValidationResult["errors"][number];
type Field = Issue["field"];

const issue = (
  field: Field,
  rule: string,
  message: string,
  index: number | null = null,
): Issue => ({
  field,
  rule,
  message,
  index,
});

/** Etsy tags accept letters, numbers, spaces, hyphens and apostrophes only. */
const ETSY_TAG_RE = /^[\p{L}\p{N} '-]+$/u;
/** Characters Etsy rejects in titles. */
const ETSY_TITLE_BAD = /[$^`]/;

/**
 * Etsy has no documented numeric cap on all-caps words in titles — its own guidance just says
 * ALL CAPS "looks spammy" (Seller Handbook "New Guidance for Listing Titles",
 * https://www.etsy.com/seller-handbook/article/1399426136697, Wayback snapshot 2025-12-02,
 * http://web.archive.org/web/20251202163448/) [U]. InvAI enforces Etsy's guidance literally — no
 * all-caps words at all — but exempts short (<=3 letter) words so real acronyms and sizes (XL,
 * DTF, US) never trip it.
 */
const ETSY_ALL_CAPS_MAX = 0;

/** Words of 4+ letters that are entirely uppercase (after stripping non-letters). */
function allCapsWords(title: string): string[] {
  return title
    .split(/\s+/)
    .filter((w) => {
      const letters = w.replace(/[^\p{L}]/gu, "");
      return letters.length >= 4 && letters === letters.toUpperCase() && /\p{Lu}/u.test(letters);
    })
    .map((w) => w.replace(/[^\p{L}]/gu, ""));
}

/**
 * Etsy's own title guidance: "Try not to repeat words" / avoid "unnecessary repeated words or
 * phrases" (same Seller Handbook source as ETSY_ALL_CAPS_MAX above). Returns the first 3-word
 * phrase (case-insensitive, punctuation-insensitive) that recurs anywhere in the title, or null.
 * A longer repeated run (4+ words) always contains a repeated 3-word window, so checking 3-grams
 * catches every "3-or-more-word phrase repeated verbatim" case.
 */
function repeatedPhrase(title: string): string | null {
  const words = title
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  const seen = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) {
    const phrase = words.slice(i, i + 3).join(" ");
    if (seen.has(phrase)) return phrase;
    seen.add(phrase);
  }
  return null;
}

/** `en / es`, the bilingual convention this validator's issue messages use (agent-brief: en+es). */
function bi(en: string, es: string): string {
  return `${en} / ${es}`;
}

/*
 * Etsy Creativity Standards: "Sellers must disclose within their listing description if an item
 * is created with the use of AI." https://www.etsy.com/legal/creativity (etsy.com returns 403 to
 * automated fetches; confirmed from the Wayback snapshot taken 2026-08-28,
 * http://web.archive.org/web/20260828105429/https://www.etsy.com/legal/creativity).
 * The rule targets the item/design, not AI-written listing copy (T-8-1 card), so this discloses
 * the *design* and never claims AI made the finished physical product — production (the DTF print
 * and press) is ours, disclosed separately by PARTNER_DISCLOSURE below.
 */
export const AI_DISCLOSURE = bi(
  "This design was created with the use of AI, based on our own prompts, then produced by us as a made-to-order DTF print.",
  "Este diseño se creó con el uso de IA, a partir de nuestras propias indicaciones, y luego lo producimos como una transferencia DTF por encargo.",
);
/**
 * Etsy Creativity Standards, "designed by a seller": "Sellers must disclose that an item is made
 * by a production partner, and provide accurate information about where the item will ship from."
 * Same source/snapshot as AI_DISCLOSURE above.
 */
export const PARTNER_DISCLOSURE = bi(
  "Made to order: designed by us, printed as a DTF transfer by our production partner and pressed in our studio.",
  "Hecho por encargo: diseñado por nosotros, impreso como transferencia DTF por nuestro socio de producción y prensado en nuestro taller.",
);

/**
 * Etsy Creativity Standards (same source as AI_DISCLOSURE): AI use must be disclosed in the
 * description. This one is about the *photos* (an AI-generated scene, ADR 0023), added to the Etsy
 * export only when an attached image is AI-generated; the design itself stays the shop's own.
 * Wording pending compliance-officer review in wave 27.
 */
export const IMAGE_AI_DISCLOSURE = bi(
  "Some product photos are AI-generated scenes; the design is our own.",
  "Algunas fotos del producto son escenas generadas con IA; el diseño es nuestro.",
);

export function validateListing(
  channel: Channel,
  content: Partial<ListingContent>,
  now = new Date(),
): ValidationResult {
  const rules = CHANNEL_RULES[channel].listing;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (content.title !== undefined) {
    const title = content.title.trim();
    if (!title)
      errors.push(
        issue("title", "title_required", bi("Title is required", "El título es obligatorio")),
      );
    if (title.length > rules.titleMax)
      errors.push(
        issue(
          "title",
          `title_max_${rules.titleMax}`,
          bi(
            `Title is ${title.length} characters; ${CHANNEL_RULES[channel].label} allows ${rules.titleMax}`,
            `El título tiene ${title.length} caracteres; ${CHANNEL_RULES[channel].label} permite ${rules.titleMax}`,
          ),
        ),
      );
    if (channel === "etsy" && ETSY_TITLE_BAD.test(title))
      errors.push(
        issue(
          "title",
          "title_invalid_chars",
          bi(
            "Etsy titles cannot contain $, ^ or `",
            "Los títulos de Etsy no pueden contener $, ^ ni `",
          ),
        ),
      );
    if (channel === "etsy" && title) {
      const caps = allCapsWords(title);
      if (caps.length > ETSY_ALL_CAPS_MAX)
        errors.push(
          issue(
            "title",
            "title_all_caps",
            bi(
              `All-caps word${caps.length === 1 ? "" : "s"} "${caps.join('", "')}" read as spam; use title case`,
              `La${caps.length === 1 ? "" : "s"} palabra${caps.length === 1 ? "" : "s"} en mayúsculas "${caps.join('", "')}" se leen como spam; usa mayúsculas y minúsculas normales`,
            ),
          ),
        );
      const phrase = repeatedPhrase(title);
      if (phrase)
        errors.push(
          issue(
            "title",
            "title_repeated_phrase",
            bi(
              `The phrase "${phrase}" repeats in the title`,
              `La frase "${phrase}" se repite en el título`,
            ),
          ),
        );
    }
  }

  if (content.description !== undefined) {
    const d = content.description.trim();
    if (!d) errors.push(issue("description", "description_required", "Description is required"));
    if (d.length > rules.descriptionMax)
      errors.push(
        issue(
          "description",
          `description_max_${rules.descriptionMax}`,
          `Description is ${d.length} characters; the limit is ${rules.descriptionMax}`,
        ),
      );
  }

  if (content.tags !== undefined) {
    const tags = content.tags;
    if (rules.tagsMax === 0) {
      if (tags.length)
        warnings.push(
          issue(
            "tags",
            "tags_unsupported",
            `${CHANNEL_RULES[channel].label} does not use tags; they will be ignored`,
          ),
        );
    } else {
      if (tags.length > rules.tagsMax)
        errors.push(
          issue(
            "tags",
            `tags_max_${rules.tagsMax}`,
            `${tags.length} tags; the limit is ${rules.tagsMax}`,
          ),
        );
      const seen = new Set<string>();
      tags.forEach((raw, i) => {
        const tag = raw.trim();
        if (!tag) errors.push(issue("tags", "tag_empty", "Empty tag", i));
        if (tag.length > rules.tagMaxLen)
          errors.push(
            issue(
              "tags",
              `tag_max_len_${rules.tagMaxLen}`,
              `Tag "${tag}" is ${tag.length} characters; the limit is ${rules.tagMaxLen}`,
              i,
            ),
          );
        if (channel === "etsy" && tag && !ETSY_TAG_RE.test(tag))
          errors.push(
            issue(
              "tags",
              "tag_invalid_chars",
              `Tag "${tag}" may only contain letters, numbers, spaces, - and '`,
              i,
            ),
          );
        const key = tag.toLowerCase();
        if (seen.has(key))
          warnings.push(issue("tags", "tag_duplicate", `Duplicate tag "${tag}"`, i));
        seen.add(key);
      });
      if (channel === "etsy" && tags.length < rules.tagsMax)
        warnings.push(
          issue(
            "tags",
            "tags_unused",
            `Only ${tags.length} of ${rules.tagsMax} tags used; every tag helps search`,
          ),
        );
    }
  }

  if (content.bullets !== undefined) {
    const bullets = content.bullets;
    if (rules.bulletsMax === 0) {
      if (bullets.length)
        warnings.push(
          issue(
            "bullets",
            "bullets_unsupported",
            `${CHANNEL_RULES[channel].label} has no bullet points; they will be ignored`,
          ),
        );
    } else {
      if (bullets.length > rules.bulletsMax)
        errors.push(
          issue(
            "bullets",
            `bullets_max_${rules.bulletsMax}`,
            `${bullets.length} bullets; the limit is ${rules.bulletsMax}`,
          ),
        );
      bullets.forEach((b, i) => {
        if (b.length > rules.bulletMaxLen)
          errors.push(
            issue(
              "bullets",
              `bullet_max_len_${rules.bulletMaxLen}`,
              `Bullet ${i + 1} is ${b.length} characters; the limit is ${rules.bulletMaxLen}`,
              i,
            ),
          );
      });
    }
  }

  if (content.price !== undefined) {
    if (content.price === null) warnings.push(issue("price", "price_missing", "No price set yet"));
    else if (content.price <= 0)
      errors.push(issue("price", "price_positive", "Price must be above zero"));
  }

  if (content.disclosures !== undefined && rules.requiresAiDisclosure) {
    if (!content.disclosures.some((d) => d.trim().length > 0))
      errors.push(
        issue(
          "disclosures",
          "disclosure_required",
          `${CHANNEL_RULES[channel].label} requires AI and production-partner disclosures`,
        ),
      );
  }

  // Etsy `production_partner_ids`: required for a POD/DTF shop (wave.md Contract stubs / C).
  // Never model-generated — filled in at generation time from companies.settings.productionPartner
  // and only checked here, so a shop with no production partner configured can't publish to Etsy.
  if (channel === "etsy" && content.productionPartner !== undefined) {
    if (content.productionPartner === null)
      errors.push(
        issue(
          "productionPartner",
          "production_partner_required",
          bi(
            "Add a production partner in Settings before publishing to Etsy",
            "Agrega un socio de producción en Configuración antes de publicar en Etsy",
          ),
        ),
      );
  }

  return { channel, ok: errors.length === 0, errors, warnings, checkedAt: now.toISOString() };
}

/** Cheap deterministic fixes applied before validation: trim, drop empties, dedupe tags. */
export function normalizeListing(channel: Channel, content: ListingContent): ListingContent {
  const rules = CHANNEL_RULES[channel].listing;
  const seen = new Set<string>();
  const tags =
    rules.tagsMax === 0
      ? []
      : content.tags
          .map((t) => t.trim().replace(/\s+/g, " "))
          .filter((t) => {
            const k = t.toLowerCase();
            if (!t || seen.has(k)) return false;
            seen.add(k);
            return true;
          });
  return {
    ...content,
    title: content.title.trim().replace(/\s+/g, " "),
    description: content.description.trim(),
    tags,
    bullets: rules.bulletsMax === 0 ? [] : content.bullets.map((b) => b.trim()).filter(Boolean),
  };
}

/** Append the AI-use and production-partner disclosures (always; Etsy requires them). */
export function withDisclosures(content: ListingContent): ListingContent {
  const disclosures = [...content.disclosures];
  for (const d of [AI_DISCLOSURE, PARTNER_DISCLOSURE])
    if (!disclosures.includes(d)) disclosures.push(d);
  return { ...content, disclosures };
}

/** Plain-text list of issues for the one retry prompt. */
export function describeIssues(result: ValidationResult): string {
  return result.errors
    .map((e) => `- ${e.field}${e.index !== null ? `[${e.index}]` : ""}: ${e.message} (${e.rule})`)
    .join("\n");
}
