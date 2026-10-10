import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { type Job, Queue, Worker } from "bullmq";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withSystem, withTenant } from "../db/client";
import { outboxEvents } from "../db/schema";
import { createCompany } from "../test/fixtures";
import { relayOnce } from "../worker/outbox-relay";
import { emit } from "./outbox";
import { defineJob, onEvent, queues, redis } from "./queues";
import { bullmqTelemetry, currentTraceparent, markTracingOn, tracingOn, withSpan } from "./tracing";
import { AllowlistExporter, SPAN_ATTRIBUTE_ALLOWLIST, startTracing } from "./tracing-sdk";

/*
 * T-32-5: trace context rides on the outbox row and BullMQ's job options (never the payload or
 * job data), outgoing fetch to imaging carries `traceparent`, and only allowlisted attributes
 * leave the process. Tracing is started here with an in-memory exporter behind the allowlist.
 */

const memory = new InMemorySpanExporter();
let provider: NodeTracerProvider;
let companyId: string;

// A local stand-in for imaging: records the headers of each request.
const seen: IncomingHttpHeaders[] = [];
const server = createServer((req, res) => {
  seen.push(req.headers);
  res.end('{"ok":true}');
});
let origin = "";

const traceIdOf = (traceparent: string | null | undefined) => traceparent?.split("-")[1];

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  provider = await startTracing({
    serviceName: "invai-test",
    processor: new SimpleSpanProcessor(new AllowlistExporter(memory)),
    propagateTo: () => origin,
  });
  companyId = (await createCompany()).id;
});

afterAll(async () => {
  await provider.shutdown();
  markTracingOn(false);
  trace.disable();
  context.disable();
  propagation.disable();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => memory.reset());

describe("attribute allowlist", () => {
  it("exports only allowlisted attributes, event attributes and no status message", async () => {
    await withSpan(
      "test span",
      {
        attributes: {
          "invai.company_id": companyId,
          "url.full": "http://x/compose?email=maria@example.com",
          "http.request.header.cookie": "session=abc",
          "bullmq.job.result": '{"buyerName":"Maria"}',
          "bullmq.job.failed.reason": "bad address 123 Main St",
        },
      },
      async (span) => {
        span.recordException(new Error("duplicate maria@example.com"));
        span.setStatus({ code: 2, message: "maria@example.com" });
      },
    );
    const [span] = memory.getFinishedSpans();
    expect(span?.attributes).toEqual({ "invai.company_id": companyId });
    expect(span?.status).toEqual({ code: 2 });
    expect(span?.events[0]?.attributes).toEqual({ "exception.type": "Error" });
    expect(JSON.stringify(span?.attributes)).not.toContain("example.com");
  });

  it("every exported key of a real request path is on the allowlist", async () => {
    await withSpan("parent", {}, () => fetch(`${origin}/compose?key=sheets/a.png&email=x@y.z`));
    const keys = memory
      .getFinishedSpans()
      .flatMap((s) => [
        ...Object.keys(s.attributes),
        ...s.events.flatMap((e) => Object.keys(e.attributes ?? {})),
      ]);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(SPAN_ATTRIBUTE_ALLOWLIST.has(k), k).toBe(true);
    const client = memory.getFinishedSpans().find((s) => s.kind === SpanKind.CLIENT);
    expect(client?.attributes["url.path"]).toBe("/compose");
    expect(JSON.stringify(client?.attributes)).not.toContain("email");
  });
});

describe("outgoing fetch", () => {
  it("sends traceparent to imaging in the caller's trace", async () => {
    seen.length = 0;
    let traceId = "";
    await withSpan("job", {}, async (span) => {
      traceId = span.spanContext().traceId;
      await fetch(`${origin}/health`);
    });
    expect(traceIdOf(seen[0]?.traceparent as string)).toBe(traceId);
  });

  it("sends no traceparent and makes no span for any other origin", async () => {
    const other = createServer((req, res) => {
      seen.push(req.headers);
      res.end("ok");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    seen.length = 0;
    await withSpan("job", {}, () =>
      fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/x`),
    );
    await new Promise<void>((r) => other.close(() => r()));
    expect(seen[0]?.traceparent).toBeUndefined();
    expect(memory.getFinishedSpans().filter((s) => s.kind === SpanKind.CLIENT)).toHaveLength(0);
  });
});

describe("outbox carries the trace, consumers don't see it", () => {
  const tracedJob = defineJob({
    queue: "sync",
    name: "test.t325.traced",
    input: z.object({ companyId: z.uuid(), orderId: z.uuid() }),
    handler: async () => "ok",
  });
  onEvent("test.t325.event", tracedJob, (e) => ({
    companyId: e.companyId,
    orderId: String(e.payload.orderId),
  }));

  beforeEach(async () => {
    await withSystem((tx) =>
      tx
        .update(outboxEvents)
        .set({ dispatchedAt: new Date() })
        .where(isNull(outboxEvents.dispatchedAt)),
    );
    await queues.sync.obliterate({ force: true });
  });

  async function emitEvent(payload: Record<string, unknown>) {
    const { id } = await withTenant(companyId, (tx) =>
      emit(tx, companyId, "test.t325.event", payload),
    );
    const [row] = await withSystem((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
    );
    return row as typeof outboxEvents.$inferSelect;
  }

  it("emit stores the active traceparent beside an unchanged payload", async () => {
    const payload = { orderId: crypto.randomUUID(), nested: { a: 1 } };
    let traceId = "";
    const row = await withSpan("orpc orders.update", {}, async (span) => {
      traceId = span.spanContext().traceId;
      expect(currentTraceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      return emitEvent(payload);
    });
    expect(traceIdOf(row.traceParent)).toBe(traceId);
    expect(row.payload).toEqual(payload);
  });

  it("emit outside any span stores null", async () => {
    const row = await context.with(ROOT_CONTEXT, () => emitEvent({ orderId: crypto.randomUUID() }));
    expect(row.traceParent).toBeNull();
  });

  it("the relay enqueues inside the row's trace with the job data unchanged", async () => {
    const orderId = crypto.randomUUID();
    let traceId = "";
    await withSpan("orpc batches.build", {}, async (span) => {
      traceId = span.spanContext().traceId;
      await emitEvent({ orderId });
    });
    const add = vi.spyOn(queues.sync, "add");
    const seenTrace: (string | undefined)[] = [];
    const seenData: unknown[] = [];
    add.mockImplementation(async (_name, data) => {
      seenTrace.push(trace.getActiveSpan()?.spanContext().traceId);
      seenData.push(data);
      return { id: "spy", data } as Job;
    });
    try {
      await context.with(ROOT_CONTEXT, () => relayOnce());
    } finally {
      add.mockRestore();
    }
    expect(seenTrace).toEqual([traceId]);
    expect(seenData).toEqual([{ companyId, orderId }]);
    const dispatch = memory.getFinishedSpans().find((s) => s.name.startsWith("outbox dispatch"));
    expect(dispatch?.spanContext().traceId).toBe(traceId);
    expect(dispatch?.attributes["invai.company_id"]).toBe(companyId);
  });
});

describe("BullMQ telemetry option", () => {
  const name = "t325-trace";
  let queue: Queue;
  let worker: Worker | undefined;

  beforeAll(async () => {
    queue = new Queue(name, { connection: redis, telemetry: bullmqTelemetry() });
    await queue.obliterate({ force: true });
  });
  afterAll(async () => {
    await worker?.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it("is present only while tracing is on", () => {
    expect(tracingOn()).toBe(true);
    expect(bullmqTelemetry()).toBeDefined();
  });

  it("the worker's job runs in the producer's trace; data and a context-free add stay clean", async () => {
    const ran: { traceId?: string; data: unknown; metadata?: string }[] = [];
    worker = new Worker(
      name,
      async (job) => {
        ran.push({
          traceId: trace.getActiveSpan()?.spanContext().traceId,
          data: job.data,
          metadata: job.opts.telemetry?.metadata,
        });
      },
      { connection: redis, telemetry: bullmqTelemetry() },
    );
    let traceId = "";
    await withSpan("producer", {}, async (span) => {
      traceId = span.spanContext().traceId;
      await queue.add("traced", { companyId, n: 1 });
    });
    await context.with(ROOT_CONTEXT, () => queue.add("untraced", { companyId, n: 2 }));
    await vi.waitUntil(() => ran.length === 2, { timeout: 10_000 });
    const traced = ran.find((r) => (r.data as { n: number }).n === 1);
    const untraced = ran.find((r) => (r.data as { n: number }).n === 2);
    expect(traced?.traceId).toBe(traceId);
    expect(traced?.data).toEqual({ companyId, n: 1 });
    expect(JSON.parse(traced?.metadata ?? "{}").traceparent).toContain(traceId);
    // No active span at add: the producer span is a new root, and the job continues that one.
    expect(untraced?.traceId).toBeDefined();
    expect(untraced?.traceId).not.toBe(traceId);
    expect(untraced?.data).toEqual({ companyId, n: 2 });
    await worker.close();
    worker = undefined;
  });

  it("two adds under one jobId collapse into the first job, which keeps the first trace", async () => {
    const ids: string[] = [];
    for (const label of ["first", "second"])
      await withSpan(label, {}, async (span) => {
        ids.push(span.spanContext().traceId);
        await queue.add("collapse", { companyId }, { jobId: "t325-same", delay: 60_000 });
      });
    const job = await queue.getJob("t325-same");
    const traceparent = JSON.parse(job?.opts.telemetry?.metadata ?? "{}").traceparent as string;
    expect(traceIdOf(traceparent)).toBe(ids[0]);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
