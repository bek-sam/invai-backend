import {
  type RealtimeEnvelope,
  type RealtimeEventName,
  RealtimeEvents,
  type RealtimePayload,
} from "@invai/contracts";
import { Redis } from "ioredis";
import { env } from "../env";
import { logger } from "./log";
import { redis } from "./queues";

const log = logger("realtime");

/**
 * Realtime fan-out for dashboards and floor tablets.
 * - `publish()` appends to a capped Redis Stream `rt:company:{id}` (replay after reconnect)
 *   and PUBLISHes on `company:{id}` (live delivery).
 * - `subscribe()` replays everything after `lastEventId`, then streams live events.
 * The SSE id is the stream entry id, so `Last-Event-ID` maps straight onto XRANGE.
 */

export type { RealtimeEnvelope, RealtimeEventName, RealtimePayload };

/** Legacy object form `{ type, data }`; prefer `publish(companyId, name, payload)`. */
export type RealtimeEvent = { type: string; data: Record<string, unknown> };

/** What subscribers receive: the contract envelope plus the company it belongs to. */
export type RealtimeMessage = RealtimeEnvelope & { companyId: string };

const STREAM_MAX_LEN = 1_000;
const streamKey = (companyId: string) => `rt:company:${companyId}`;
const channel = (companyId: string) => `company:${companyId}`;

/**
 * Publish a contracts `RealtimeEvents` event. Known names are validated against their schema
 * (a bad payload is logged and dropped, never thrown). The wire format is the contract's
 * `RealtimeEnvelope` `{ id, name, at, payload }`, with `id` = the Redis stream id.
 */
export async function publish<E extends RealtimeEventName>(
  companyId: string,
  name: E,
  payload: RealtimePayload<E>,
): Promise<string | null>;
export async function publish(companyId: string, event: RealtimeEvent): Promise<string | null>;
export async function publish(
  companyId: string,
  nameOrEvent: string | RealtimeEvent,
  maybePayload?: Record<string, unknown>,
): Promise<string | null> {
  const name = typeof nameOrEvent === "string" ? nameOrEvent : nameOrEvent.type;
  let payload = (typeof nameOrEvent === "string" ? maybePayload : nameOrEvent.data) ?? {};
  const schema = (
    RealtimeEvents as Record<
      string,
      { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } }
    >
  )[name];
  if (schema) {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      log.warn("invalid realtime payload dropped", {
        companyId,
        name,
        error: String(parsed.error),
      });
      return null;
    }
    payload = parsed.data as Record<string, unknown>;
  } else {
    log.warn("unknown realtime event name", { companyId, name });
  }
  const at = new Date().toISOString();
  try {
    const id = await redis.xadd(
      streamKey(companyId),
      "MAXLEN",
      "~",
      STREAM_MAX_LEN,
      "*",
      "body",
      JSON.stringify({ name, at, payload }),
    );
    if (!id) return null;
    const message: RealtimeMessage = { id, name, at, payload, companyId };
    await redis.publish(channel(companyId), JSON.stringify(message));
    return id;
  } catch (err) {
    // Realtime is best-effort; the database is the source of truth.
    log.warn("publish failed", { companyId, name, error: String(err) });
    return null;
  }
}

function parseEntry(companyId: string, [id, fields]: [string, string[]]): RealtimeMessage | null {
  const idx = fields.indexOf("body");
  const raw = idx >= 0 ? fields[idx + 1] : undefined;
  if (!raw) return null;
  try {
    const body = JSON.parse(raw) as {
      name?: string;
      type?: string;
      at: string;
      payload?: Record<string, unknown>;
      data?: Record<string, unknown>;
    };
    // Entries written before the envelope fix used { type, data }.
    return {
      id,
      companyId,
      name: body.name ?? body.type ?? "unknown",
      at: body.at,
      payload: body.payload ?? body.data ?? {},
    };
  } catch {
    return null;
  }
}

/** Events after `lastEventId` (exclusive), oldest first. */
export async function replay(companyId: string, lastEventId: string): Promise<RealtimeMessage[]> {
  const entries = (await redis.xrange(streamKey(companyId), `(${lastEventId}`, "+")) as [
    string,
    string[],
  ][];
  return entries.map((e) => parseEntry(companyId, e)).filter((m): m is RealtimeMessage => !!m);
}

/**
 * Live subscription. Each subscriber gets its own Redis connection (pub/sub mode blocks a
 * connection). Returns an unsubscribe function.
 */
export function subscribe(
  companyId: string,
  onMessage: (m: RealtimeMessage) => void,
): () => Promise<void> {
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  sub.on("message", (_ch, raw) => {
    try {
      const m = JSON.parse(raw) as RealtimeMessage & {
        type?: string;
        data?: Record<string, unknown>;
      };
      onMessage({
        id: m.id,
        companyId: m.companyId,
        name: m.name ?? m.type ?? "unknown",
        at: m.at,
        payload: m.payload ?? m.data ?? {},
      });
    } catch (err) {
      log.warn("bad realtime message", { error: String(err) });
    }
  });
  sub.on("error", (err) => log.warn("subscriber error", { error: err.message }));
  void sub.subscribe(channel(companyId));
  return async () => {
    try {
      await sub.unsubscribe(channel(companyId));
    } finally {
      sub.disconnect();
    }
  };
}
