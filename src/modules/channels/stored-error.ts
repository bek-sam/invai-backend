import { isORPCError } from "../../lib/errors";
import { errorData } from "../../lib/log";

/**
 * Text written to a column, a job row, an outbox payload or an audit row when a marketplace call
 * fails (B-353, B-354). A marketplace's own message can quote a buyer's name or address, so a
 * failure of a call to the channel stores a fixed plain sentence with a code in parentheses. The
 * dashboard shows the stored text as is (connection health, sync job).
 */

/** Text from our own code or the database, without a query's parameters. Empty becomes "failed". */
export function scrubbedError(err: unknown): string {
  const text = String(errorData(err).error).trim();
  return text || "failed";
}

/**
 * A failed call to a marketplace: `sentence` with the best code we have. Our own errors (oRPC
 * errors carry fixed messages, except `UPSTREAM_FAILED` whose message holds the provider's text)
 * keep their code; any other error is the provider's text and is dropped.
 */
export function storedChannelError(err: unknown, sentence: string, fallbackCode: string): string {
  const code = isORPCError(err) ? err.code : fallbackCode;
  return `${sentence} (${code})`;
}
