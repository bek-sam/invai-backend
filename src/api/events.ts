import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db/client";
import { logger } from "../lib/log";
import { type RealtimeEnvelope, type RealtimeMessage, replay, subscribe } from "../lib/realtime";
import { buildContext } from "./context";
import { shuttingDown } from "./shutdown";

const log = logger("sse");

/** Ping and re-check interval. Keep under common proxy idle timeouts (30-60 s). */
export const SSE_PING_MS = 25_000;
/** Retry hint when a re-check can't tell (database unreachable): reconnect, not sign out. */
export const SSE_RECHECK_RETRY_MS = 5_000;

export type EventsOptions = {
  pingMs?: number;
  /** Is the database answering? Tests inject a failing probe. */
  probe?: () => Promise<boolean>;
};

async function dbProbe(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Server-Sent Events at /events, scoped to the caller's company. Auth: the Better Auth cookie or
 * a floor session as `Authorization: Bearer` (the floor reads the stream over fetch). A session
 * in the query string is not accepted (B-31, S-30): URLs end up in proxy and access logs.
 * `Last-Event-ID` (header or `?lastEventId=`) replays from the Redis stream before going live.
 * Wire format matches contracts realtime.ts:
 *   event: <name>  id: <stream id>  data: { id, name, at, payload }
 *
 * Every ping interval the stream re-runs `buildContext` with the original credentials. When the
 * session is gone (signed out, floor session or station token revoked, member deactivated) or
 * now points at another company, the server writes `event: unauthorized` (no `retry:`) and
 * closes; the reconnect gets 401. `buildContext` turns any error into "anonymous", so a failed
 * re-check counts as a revoke only if a `select 1` probe succeeds; otherwise the stream ends
 * with a `shutdown` event and a retry hint, as on SIGTERM (architect ruling C1, T-P6-2).
 * Timing: one interval (25 s) on one instance; the 30 s station-token cache adds up to 30 s
 * across instances (ruling C2).
 */
export function createEvents(opts: EventsOptions = {}) {
  const pingMs = opts.pingMs ?? SSE_PING_MS;
  const probe = opts.probe ?? dbProbe;
  const route = new Hono();

  route.get("/", async (c) => {
    // Copy only the headers: the query string carries no credentials any more.
    const headers = new Headers(c.req.raw.headers);
    const authRequest = () => new Request(c.req.url, { headers });
    const ctx = await buildContext(authRequest());
    if (!ctx.companyId || !(ctx.sessionKind === "user" || ctx.sessionKind === "floor")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const companyId = ctx.companyId;
    const sessionKind = ctx.sessionKind;
    const lastEventId =
      c.req.header("last-event-id") ?? new URL(c.req.url).searchParams.get("lastEventId");

    /** "ok" = still allowed; "revoked" = provably gone; "unknown" = couldn't tell. */
    const recheck = async (): Promise<"ok" | "revoked" | "unknown"> => {
      const now = await buildContext(authRequest());
      if (now.companyId === companyId && now.sessionKind === sessionKind) return "ok";
      return (await probe()) ? "revoked" : "unknown";
    };

    return streamSSE(c, async (stream) => {
      let open = true;
      const send = (m: RealtimeMessage) => {
        if (!open) return;
        const envelope: RealtimeEnvelope = { id: m.id, name: m.name, at: m.at, payload: m.payload };
        return stream.writeSSE({ event: m.name, id: m.id, data: JSON.stringify(envelope) });
      };

      const queue: RealtimeMessage[] = [];
      let replaying = true;
      const unsubscribe = subscribe(companyId, (m) => {
        if (replaying) queue.push(m);
        else void send(m);
      });
      const close = () => {
        open = false;
        void unsubscribe();
      };
      stream.onAbort(close);

      try {
        if (lastEventId) {
          const missed = await replay(companyId, lastEventId);
          for (const m of missed) await send(m);
          const lastReplayed = missed[missed.length - 1]?.id ?? lastEventId;
          for (const m of queue) if (m.id > lastReplayed) await send(m);
        } else {
          for (const m of queue) await send(m);
        }
      } catch (err) {
        log.warn("replay failed", { companyId, error: String(err) });
      }
      replaying = false;
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ companyId }) });

      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        // T-12-2 (B-16): on SIGTERM, don't hold this connection open for the server's whole drain
        // window. Wake up as soon as shutdown begins (instead of only at the next ping) so the
        // client gets a retry hint and reconnects to a fresh instance instead of timing out.
        const woke = await Promise.race([
          stream.sleep(pingMs).then(() => "timer" as const),
          shuttingDown.then(() => "shutdown" as const),
        ]);
        if (stream.aborted) break;
        if (woke === "shutdown") {
          close();
          await stream.writeSSE({ event: "shutdown", data: "", retry: 1000 });
          break;
        }
        const state = await recheck();
        if (state === "revoked") {
          close();
          log.info("stream closed: session no longer valid", { companyId, sessionKind });
          await stream.writeSSE({ event: "unauthorized", data: "" });
          break;
        }
        if (state === "unknown") {
          close();
          log.warn("stream re-check failed, database unreachable", { companyId, sessionKind });
          await stream.writeSSE({ event: "shutdown", data: "", retry: SSE_RECHECK_RETRY_MS });
          break;
        }
      }
    });
  });

  return route;
}

export const events = createEvents();
