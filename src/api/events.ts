import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

/**
 * Server-Sent Events for dashboards and floor tablets.
 * TODO: subscribe to Redis pub/sub channel `company:{id}` and replay from a Redis Stream
 * using the Last-Event-ID header after reconnects.
 */
export const events = new Hono();

events.get("/", (c) =>
  streamSSE(c, async (stream) => {
    while (!stream.aborted) {
      await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      await stream.sleep(25_000);
    }
  }),
);
