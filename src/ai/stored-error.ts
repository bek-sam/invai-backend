import { ORPCError } from "@orpc/server";
import { cutWhole, sanitizeText } from "../lib/text-safety";
import { stripPii } from "./pii";

/**
 * Text that may be written to `ai_jobs.error`, `listing_drafts.error` or an outbox event, and is
 * shown to the shop as written. Provider and SDK errors can echo the prompt or model output, and
 * free text cannot be scrubbed reliably, so only fixed wording leaves this function:
 * - `UPSTREAM_FAILED` carries provider detail in its message: store the fixed sentence without it;
 * - any other typed `ORPCError` has a message our own code wrote, so it is kept (scrubbed);
 * - everything else becomes one plain sentence. The full error goes to the log via `errorData`.
 */
export function storedErrorText(err: unknown): string {
  if (err instanceof ORPCError) {
    if (err.code === "UPSTREAM_FAILED") {
      const service = (err.data as { service?: unknown } | null)?.service;
      const name = typeof service === "string" && service.length <= 40 ? service : "The AI service";
      return `${name} could not finish this request. Try again in a minute. (UPSTREAM_FAILED)`;
    }
    const text = cutWhole(stripPii(sanitizeText(err.message)).trim(), 300);
    return text || "failed";
  }
  return "The AI service could not finish this request. Try again in a minute. (INTERNAL)";
}
