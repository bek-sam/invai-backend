import { desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTenant } from "../db/client";
import { aiJobs } from "../db/schema";
import { createCompany } from "../test/fixtures";
import { runAssistant } from "./gateway";
import { ASSISTANT_PROMPT } from "./prompts";

/*
 * T-49-1 (S-86, AC3): the assistant message stored on ai_jobs.input is cut on a whole character.
 * A real gateway turn with the mock provider on invai_test; before the fix a half emoji at unit
 * 500 made the jsonb write fail (22P02) and the turn with it.
 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("assistant turn: stored message cut", () => {
  it("an emoji across unit 500 is dropped whole and the ai_jobs row is written", async () => {
    const company = await createCompany();
    const message = `${"m".repeat(499)}😀 and then some more words`;
    const gen = runAssistant(
      { companyId: company.id, userId: null, kind: "assistant", creditKind: "assistant" },
      { system: ASSISTANT_PROMPT.system, history: [], message, tools: [], now: new Date() },
    );
    let step = await gen.next();
    while (!step.done) step = await gen.next();

    const rows = await withTenant(company.id, (tx) =>
      tx.select().from(aiJobs).where(eq(aiJobs.id, step.value.aiJobId)).orderBy(desc(aiJobs.id)),
    );
    expect(rows).toHaveLength(1);
    const input = rows[0]?.input as { message?: string } | undefined;
    const stored = input?.message ?? "";
    expect(stored.length).toBeLessThanOrEqual(500);
    expect(LONE.test(stored)).toBe(false);
    expect(stored).toBe("m".repeat(499));
  });
});
