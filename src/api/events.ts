import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { logger } from "../lib/log";
import { type RealtimeMessage, replay, subscribe } from "../lib/realtime";
import { buildContext } from "./context";

const log = logger("sse");

/**
 * Server-Sent Events at /events, scoped to the caller's company. Auth: the Better Auth cookie,
 * a floor session as `Authorization: Bearer` or, because EventSource cannot set headers,
 * `?token=<floor session>`. `Last-Event-ID` (header or `?lastEventId=`) replays from the Redis
 * stream before going live. Wire format matches contracts realtime.ts:
 *   event: <name>  id: <stream id>  data: { id, name, at, payload }
 */
export const events = new Hono();

events.get("/", async (c) => {
  const url = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  const token = url.searchParams.get("token");
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  const ctx = await buildContext(new Request(c.req.url, { headers }));
  if (!ctx.companyId || !(ctx.sessionKind === "user" || ctx.sessionKind === "floor")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const companyId = ctx.companyId;
  const lastEventId = c.req.header("last-event-id") ?? url.searchParams.get("lastEventId");

  return streamSSE(c, async (stream) => {
    const send = (m: RealtimeMessage) =>
      stream.writeSSE({
        event: m.type,
        id: m.id,
        data: JSON.stringify({ id: m.id, name: m.type, at: m.at, payload: m.data }),
      });

    const queue: RealtimeMessage[] = [];
    let replaying = true;
    const unsubscribe = subscribe(companyId, (m) => {
      if (replaying) queue.push(m);
      else void send(m);
    });
    stream.onAbort(() => void unsubscribe());

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
      await stream.sleep(25_000);
    }
  });
});
