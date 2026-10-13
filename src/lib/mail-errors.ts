/*
 * What may be said about a failed mail send (B-306, B-441, S-29 class). SMTP errors quote the
 * recipient ("550 5.1.1 <someone@example.com>: user unknown") in `message`, `response`, `command`
 * and `stack`, so none of those ever reaches a log line, a stored row or a rethrown error: only a
 * short error name, a short code and the numeric SMTP reply code.
 */

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;
const safeCode = (v: unknown) => (typeof v === "string" && SAFE_CODE.test(v) ? v : undefined);

/**
 * What the log may say about a failed send: the error class name, a short code, and the numeric
 * SMTP reply code. Never the message, `response` or `command`.
 */
export function mailErrorFields(err: unknown): {
  errorName: string;
  code?: string;
  responseCode?: number;
} {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; responseCode?: unknown };
  return {
    errorName: safeCode(e.name) ?? "UnknownError",
    code: safeCode(e.code),
    responseCode: typeof e.responseCode === "number" ? e.responseCode : undefined,
  };
}

const TRANSPORT_CODE = /^E[A-Z0-9_]{1,30}$/;

/**
 * A short, closed-vocabulary reason (`^[a-z0-9_]{1,40}$`) for the `email_sends` row:
 * `smtp_<reply code>` for an SMTP reply 200-599, else `transport_<code>` for a Node/nodemailer
 * code such as `ECONNREFUSED`, else `transport_error`. Never any transport text.
 */
export function mailFailureReason(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown };
  const rc = e.responseCode;
  if (typeof rc === "number" && Number.isInteger(rc) && rc >= 200 && rc <= 599) return `smtp_${rc}`;
  if (typeof e.code === "string" && TRANSPORT_CODE.test(e.code))
    return `transport_${e.code.toLowerCase()}`.slice(0, 40);
  return "transport_error";
}

/** What `sendUserEmail` throws for a transport failure: the reason only, no cause (it holds the address). */
export class MailSendError extends Error {
  override name = "MailSendError";
}
