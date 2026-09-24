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

export type RealtimeEvent = {
  /** Dotted type, e.g. `item.updated`, `sheet.status`, `alert.created`. */
  type: string;
  data: Record<string, unknown>;
};

export type RealtimeMessage = RealtimeEvent & { id: string; companyId: string; at: string };

const STREAM_MAX_LEN = 1_000;
const streamKey = (companyId: string) => `rt:company:${companyId}`;
const channel = (companyId: string) => `company:${companyId}`;

export async function publish(companyId: string, event: RealtimeEvent): Promise<string | null> {
  const at = new Date().toISOString();
  const body = JSON.stringify({ type: event.type, data: event.data, at });
  try {
    const id = await redis.xadd(
      streamKey(companyId),
      "MAXLEN",
      "~",
      STREAM_MAX_LEN,
      "*",
      "body",
      body,
    );
    if (!id) return null;
    const message: RealtimeMessage = { id, companyId, type: event.type, data: event.data, at };
    await redis.publish(channel(companyId), JSON.stringify(message));
    return id;
  } catch (err) {
    // Realtime is best-effort; the database is the source of truth.
    log.warn("publish failed", { companyId, type: event.type, error: String(err) });
    return null;
  }
}

function parseEntry(companyId: string, [id, fields]: [string, string[]]): RealtimeMessage | null {
  const idx = fields.indexOf("body");
  const raw = idx >= 0 ? fields[idx + 1] : undefined;
  if (!raw) return null;
  try {
    const body = JSON.parse(raw) as { type: string; data: Record<string, unknown>; at: string };
    return { id, companyId, ...body };
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
      onMessage(JSON.parse(raw) as RealtimeMessage);
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
