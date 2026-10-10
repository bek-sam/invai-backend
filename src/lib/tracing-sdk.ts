import type { Attributes } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { markTracingOn } from "./tracing";

/*
 * The OpenTelemetry SDK, loaded only when tracing is on (lib/telemetry.ts imports this module
 * dynamically, so with OTEL_EXPORTER_OTLP_ENDPOINT unset none of these packages load).
 *
 * Every exported span passes `allowlistSpan` first: only the attribute keys below survive, events
 * keep only `exception.type`, and status messages are dropped. Instrumentations add URL query
 * strings, headers, BullMQ job results and failure reasons, error messages and stacks; none of
 * that may reach a collector (buyer PII, S-29).
 */
export const SPAN_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  // our own spans
  "invai.company_id",
  "invai.request_id",
  "invai.event",
  "invai.job.name",
  "invai.queue",
  "rpc.method",
  "http.route",
  // HTTP (incoming and the undici client): method, status, path without query, sizes
  "http.request.method",
  "http.response.status_code",
  "url.path",
  "url.scheme",
  "server.address",
  "server.port",
  "http.request.body.size",
  "http.response.body.size",
  "error.type",
  // BullMQ (TelemetryAttributes): names, ids and counters, never options, results or reasons
  "bullmq.queue.name",
  "bullmq.queue.operation",
  "bullmq.job.name",
  "bullmq.job.id",
  "bullmq.job.attempts.made",
  "bullmq.worker.name",
  // exceptions: the type only
  "exception.type",
]);

function allowed(attrs: Attributes | undefined): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (SPAN_ATTRIBUTE_ALLOWLIST.has(k)) out[k] = v;
  return out;
}

/** A copy of the span with only allowlisted attributes, event attributes and no status message. */
export function allowlistSpan(span: ReadableSpan): ReadableSpan {
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes: allowed(span.attributes),
    links: span.links.map((l) => ({ context: l.context, attributes: allowed(l.attributes) })),
    events: span.events.map((e) => ({
      name: e.name,
      time: e.time,
      attributes: allowed(e.attributes),
    })),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/**
 * BullMQ opens an INTERNAL root span on every idle poll and timer tick (`getNextJob`,
 * `startStalledCheckTimer`, ...); a root INTERNAL BullMQ span carries no request, so it is dropped.
 */
function isQueueNoise(span: ReadableSpan): boolean {
  return span.instrumentationScope.name === "bullmq" && span.kind === 0 && !span.parentSpanContext;
}

/** Wraps an exporter so it only ever sees allowlisted spans. */
export class AllowlistExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}
  export(spans: ReadableSpan[], done: Parameters<SpanExporter["export"]>[1]) {
    this.inner.export(spans.filter((s) => !isQueueNoise(s)).map(allowlistSpan), done);
  }
  shutdown() {
    return this.inner.shutdown();
  }
  forceFlush() {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export type TracingOptions = {
  serviceName: string;
  /** OTLP/HTTP base URL (`/v1/traces` is appended). Ignored when `processor` is given. */
  endpoint?: string;
  /** Tests pass a processor around an in-memory exporter (still allowlisted by the caller). */
  processor?: SpanProcessor;
  /** Origin whose outgoing `fetch` calls get a client span and a `traceparent` header. */
  propagateTo?: () => string | undefined;
};

/**
 * Registers the tracer provider (AsyncLocalStorage context, W3C trace-context propagator) and the
 * undici instrumentation for global `fetch`. Only calls to `propagateTo()`'s origin (imaging) are
 * traced, so no `traceparent` header goes to a third party (AI providers, marketplaces).
 */
export async function startTracing(opts: TracingOptions): Promise<NodeTracerProvider> {
  let processor = opts.processor;
  if (!processor) {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const url = `${(opts.endpoint ?? "").replace(/\/+$/, "")}/v1/traces`;
    processor = new BatchSpanProcessor(new AllowlistExporter(new OTLPTraceExporter({ url })));
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": opts.serviceName }),
    spanProcessors: [processor],
  });
  provider.register();
  markTracingOn(true);

  const { UndiciInstrumentation } = await import("@opentelemetry/instrumentation-undici");
  new UndiciInstrumentation({
    ignoreRequestHook: (req) => {
      const target = opts.propagateTo?.();
      return !target || req.origin !== target;
    },
  });
  return provider;
}
