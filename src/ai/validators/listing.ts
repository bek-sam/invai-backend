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

export const AI_DISCLOSURE = "Listing copy drafted with AI assistance and reviewed by our team.";
export const PARTNER_DISCLOSURE =
  "Made to order: designed by us, printed as a DTF transfer by our production partner and pressed in our studio.";

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
    if (!title) errors.push(issue("title", "title_required", "Title is required"));
    if (title.length > rules.titleMax)
      errors.push(
        issue(
          "title",
          `title_max_${rules.titleMax}`,
          `Title is ${title.length} characters; ${CHANNEL_RULES[channel].label} allows ${rules.titleMax}`,
        ),
      );
    if (channel === "etsy" && ETSY_TITLE_BAD.test(title))
      errors.push(issue("title", "title_invalid_chars", "Etsy titles cannot contain $, ^ or `"));
    if (title && title === title.toUpperCase() && /[A-Z]{4,}/.test(title))
      warnings.push(
        issue("title", "title_all_caps", "All-caps titles read as spam; use title case"),
      );
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
