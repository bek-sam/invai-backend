import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { withTenant } from "../db/client";
import { members, NOTIFICATION_KINDS, type NotificationKind } from "../db/schema";
import { env } from "../env";
import { getLinkHandler, type LinkPayload, safeWebPath, verifyLinkToken } from "../lib/links";
import { errorData, logger } from "../lib/log";
import { setEmailPreference, undoUnsubscribe } from "../lib/notify";
import { RATE_BUCKET_LIMITS, rateLimitKey, takeToken } from "../lib/ratelimit";
import { clientIp } from "./context";

const log = logger("links");

/*
 * Public email-link routes, `/l/:token` (wave 19, ADR 0016; shape pinned in the contracts README
 * "Public link routes"). No session: the token is the credential. It is verified (signature,
 * version, expiry) and then bound to an *active membership* of that person in that company before
 * anything happens, so a token edited towards another shop or person does nothing anywhere.
 *
 *   GET  /l/:token   never changes a preference. `unsubscribe` -> 302 to the web confirm page;
 *                    `click` -> the registered handler records the click, 302 to a same-origin path.
 *   POST /l/:token   `unsubscribe` only (`click` -> 405): RFC 8058 one-click, idempotent, 200 on a
 *                    repeat; JSON `{ "undo": true }` restores it within 24 h, else 409.
 *
 * The API origin serves `default-src 'none'`, so nothing here renders HTML: every human-facing
 * outcome is a redirect to `WEB_ORIGIN`. Per-IP `links` bucket, 60/min. The token never reaches a
 * log line: only the outcome and, once verified, the ids do.
 */
export const links = new Hono();

const NO_STORE = { "Cache-Control": "no-store" };
const invalidPage = () => `${env.WEB_ORIGIN}/unsubscribe?error=invalid`;
const confirmPage = (token: string) =>
  `${env.WEB_ORIGIN}/unsubscribe?token=${encodeURIComponent(token)}`;

async function limited(headers: Headers): Promise<number | null> {
  const ip = clientIp(headers) ?? "unknown";
  const { allowed, retryAfterSec } = await takeToken(
    rateLimitKey("links", ip),
    RATE_BUCKET_LIMITS.links,
  );
  return allowed ? null : retryAfterSec;
}

/** The token's person is an active member of the token's company right now. */
async function boundToMembership(p: LinkPayload): Promise<boolean> {
  return withTenant(p.c, async (tx) => {
    const [row] = await tx
      .select({ status: members.status })
      .from(members)
      .where(and(eq(members.organizationId, p.c), eq(members.userId, p.u)))
      .limit(1);
    return row?.status === "active";
  });
}

function isNotificationKind(ref: string): ref is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(ref);
}

/** Verify + bind, with the route-specific answer for a bad token. */
async function resolve(token: string): Promise<LinkPayload | null> {
  const payload = verifyLinkToken(token);
  if (!payload) return null;
  if (!(await boundToMembership(payload))) {
    log.warn("email link for a person who is not an active member", {
      companyId: payload.c,
      userId: payload.u,
      kind: payload.k,
    });
    return null;
  }
  return payload;
}

links.get("/:token", async (c) => {
  const retryAfter = await limited(c.req.raw.headers);
  if (retryAfter !== null) {
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: "too many requests" }, 429);
  }
  const token = c.req.param("token");
  const payload = await resolve(token);
  c.header("Cache-Control", NO_STORE["Cache-Control"]);
  if (!payload) return c.redirect(invalidPage(), 302);

  if (payload.k === "unsubscribe") {
    if (!isNotificationKind(payload.r)) return c.redirect(invalidPage(), 302);
    return c.redirect(confirmPage(token), 302);
  }

  const handler = getLinkHandler("click");
  if (!handler) return c.redirect(`${env.WEB_ORIGIN}/`, 302);
  try {
    const target = await handler({ companyId: payload.c, userId: payload.u, ref: payload.r });
    return c.redirect(`${env.WEB_ORIGIN}${safeWebPath(target?.path)}`, 302);
  } catch (err) {
    log.error("click handler failed", {
      companyId: payload.c,
      userId: payload.u,
      ...errorData(err),
    });
    return c.redirect(`${env.WEB_ORIGIN}/`, 302);
  }
});

/** RFC 8058 one-click (form body or none) or the web page's Undo (JSON `{ "undo": true }`). */
async function wantsUndo(c: {
  req: { header: (n: string) => string | undefined; json: () => Promise<unknown> };
}) {
  const type = c.req.header("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) return false;
  try {
    const body = (await c.req.json()) as { undo?: unknown } | null;
    return body?.undo === true;
  } catch {
    return false;
  }
}

links.post("/:token", async (c) => {
  const retryAfter = await limited(c.req.raw.headers);
  if (retryAfter !== null) {
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: "too many requests" }, 429);
  }
  c.header("Cache-Control", NO_STORE["Cache-Control"]);
  const payload = await resolve(c.req.param("token"));
  if (!payload) return c.json({ error: "invalid link" }, 400);
  if (payload.k !== "unsubscribe") return c.json({ error: "method not allowed" }, 405);
  if (!isNotificationKind(payload.r)) return c.json({ error: "invalid link" }, 400);

  const ids = { companyId: payload.c, userId: payload.u, kind: payload.r };
  if (await wantsUndo(c)) {
    const result = await undoUnsubscribe(payload.c, payload.u, payload.r);
    if (result !== "restored") {
      log.info("unsubscribe undo refused", { ...ids, result });
      return c.json({ ok: false, error: result }, 409);
    }
    log.info("unsubscribe undone", ids);
    return c.json({ ok: true, undone: true }, 200);
  }

  await setEmailPreference(payload.c, payload.u, payload.r, {
    on: false,
    source: "unsubscribe_link",
  });
  log.info("one-click unsubscribe", ids);
  return c.json({ ok: true }, 200);
});
