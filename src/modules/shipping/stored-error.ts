import { CarrierError } from "../../integrations/carriers/types";
import { isORPCError } from "../../lib/errors";
import { errorData } from "../../lib/log";

/**
 * Text that is written to a column, a job result, an alert or an outbox payload when a carrier or
 * channel call fails (B-353, B-354). A provider's own message can quote the ship-to address, so
 * provider failures store a fixed plain sentence with the code in parentheses. The web shows the
 * stored text as is (shipping page, tracking push error).
 */

const CARRIER_SENTENCE: Record<CarrierError["code"], string> = {
  address_invalid: "The carrier could not deliver to this address",
  rate_expired: "The carrier rate expired",
  upstream: "The carrier did not answer",
};

/** The code of an error we know how to name, else null. */
function knownCode(err: unknown): string | null {
  if (err instanceof CarrierError) return err.code;
  if (isORPCError(err)) return err.code;
  return null;
}

/**
 * For a failure that may come from an outside provider: carrier errors and `UPSTREAM_FAILED`
 * (whose message holds the provider's detail) become a fixed sentence plus code. Our own errors
 * carry fixed messages, so they keep them; anything else (a database error) is scrubbed of its
 * query parameters. An empty text becomes "failed".
 */
export function storedError(err: unknown): string {
  if (err instanceof CarrierError) return `${CARRIER_SENTENCE[err.code]} (${err.code})`;
  if (isORPCError(err) && err.code === "UPSTREAM_FAILED")
    return "An outside service could not complete the request (UPSTREAM_FAILED)";
  return scrubbed(err);
}

/**
 * For a call made to a channel or carrier where every failure that is not one of ours is the
 * provider's text: store `sentence` with the best code we have (`fallbackCode` when none).
 */
export function storedProviderError(err: unknown, sentence: string, fallbackCode: string): string {
  if (err instanceof CarrierError || isORPCError(err)) return storedError(err);
  return `${sentence} (${knownCode(err) ?? fallbackCode})`;
}

export function scrubbed(err: unknown): string {
  const text = String(errorData(err).error).trim();
  return text || "failed";
}
