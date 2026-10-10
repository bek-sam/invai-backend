import {
  type Attributes,
  type Context,
  context,
  INVALID_SPAN_CONTEXT,
  type Link,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { QueueBaseOptions } from "bullmq";

/*
 * Trace helpers the app code uses (T-32-5, B-18). They only touch `@opentelemetry/api`, which is
 * a no-op until `lib/telemetry.ts` (loaded with `node --import`) starts the SDK, so with tracing
 * off every helper here returns undefined/null or just runs `fn`.
 *
 * Carriers: the W3C `traceparent` of the emitting span rides on `outbox_events.trace_parent`
 * (never in the payload), the relay enqueues inside it, and BullMQ carries it on to the worker in
 * `JobsOptions.telemetry.metadata` (never in job data). See `invai-backend/src/modules/README.md`.
 */

const ON = Symbol.for("invai.tracing.on");

/** True once `startTracing()` registered the SDK in this process. */
export function tracingOn(): boolean {
  return Reflect.get(globalThis, ON) === true;
}

export function markTracingOn(on: boolean) {
  Reflect.set(globalThis, ON, on);
}

const tracer = () => trace.getTracer("invai");

/** The active span's W3C `traceparent`, or null (tracing off, or no span in this context). */
export function currentTraceparent(): string | null {
  if (!tracingOn()) return null;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/** A context whose parent is the given `traceparent` (or a fresh root when there is none). */
export function contextFromTraceparent(traceparent: string | null | undefined): Context {
  if (!traceparent) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, { traceparent });
}

/** The active trace id, for log lines; undefined when tracing is off or no span is active. */
export function activeTraceId(): string | undefined {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && trace.isSpanContextValid(sc) ? sc.traceId : undefined;
}

/** Sets attributes on the active span (no-op without one). Only allowlisted keys are exported. */
export function setSpanAttributes(attrs: Attributes) {
  trace.getActiveSpan()?.setAttributes(attrs);
}

/**
 * Runs `fn` in a new span (child of `parent`, default: the active context). The span ends when
 * `fn` settles; a throw marks it as an error, without the message (it may carry PII).
 */
export async function withSpan<T>(
  name: string,
  opts: { kind?: SpanKind; attributes?: Attributes; parent?: Context; links?: Link[] },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  if (!tracingOn()) return fn(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
  const parent = opts.parent ?? context.active();
  const span = tracer().startSpan(
    name,
    { kind: opts.kind, attributes: opts.attributes, links: opts.links },
    parent,
  );
  try {
    return await context.with(trace.setSpan(parent, span), () => fn(span));
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}

/**
 * An incoming request's `traceparent` as a span link, never as the parent (S-69): a caller must
 * not pick our trace id or turn sampling off with flags `00`. Empty when tracing is off, or the
 * header is absent or malformed. The request span itself is always a new root.
 */
export function linksFromHeaders(headers: Headers): Link[] {
  if (!tracingOn()) return [];
  const incoming = propagation.extract(ROOT_CONTEXT, headers, {
    keys: () => [...headers.keys()],
    get: (h, key) => h.get(key) ?? undefined,
  });
  const sc = trace.getSpanContext(incoming);
  return sc && trace.isSpanContextValid(sc) ? [{ context: sc }] : [];
}

type BullTelemetry = NonNullable<QueueBaseOptions["telemetry"]>;
type BullSpan = ReturnType<BullTelemetry["tracer"]["startSpan"]>;

function bullSpan(span: Span): BullSpan {
  return {
    setSpanOnContext: (ctx: Context) => trace.setSpan(ctx, span),
    setAttribute: (key, value) => span.setAttribute(key, value),
    setAttributes: (attrs) => span.setAttributes(attrs as Attributes),
    addEvent: (name, attrs) => span.addEvent(name, attrs as Attributes | undefined),
    recordException: (exception, time) => {
      // Only the type is kept: BullMQ passes the job's error, whose message may echo input.
      const type =
        typeof exception === "string" ? "Error" : (exception.name ?? String(exception.code ?? ""));
      span.recordException({ name: type || "Error", message: "" }, time);
      span.setStatus({ code: SpanStatusCode.ERROR });
    },
    end: () => span.end(),
  };
}

/**
 * BullMQ's `telemetry` option (BullMQ 6.3 `interfaces/telemetry.d.ts`) backed by OpenTelemetry, or
 * undefined when tracing is off, so Queue and Worker get the option only then. `Queue.add` stores
 * the producer span's context as `opts.telemetry.metadata` (a JSON carrier with `traceparent`);
 * the Worker's `process` span continues it. A job added with no active span starts a new root.
 * Two adds under one jobId collapse into the first job, which keeps the first add's trace.
 */
export function bullmqTelemetry(): BullTelemetry | undefined {
  if (!tracingOn()) return undefined;
  return {
    tracer: {
      startSpan: (name, options, ctx?: Context) =>
        bullSpan(
          trace
            .getTracer("bullmq")
            .startSpan(
              name,
              { kind: options?.kind as number as SpanKind },
              ctx ?? context.active(),
            ),
        ),
    },
    contextManager: {
      with: (ctx: Context, fn) => context.with(ctx, fn),
      active: () => context.active(),
      getMetadata: (ctx: Context) => {
        const carrier: Record<string, string> = {};
        propagation.inject(ctx, carrier);
        return JSON.stringify(carrier);
      },
      fromMetadata: (active: Context, metadata: string) => {
        try {
          return propagation.extract(active, JSON.parse(metadata) as Record<string, string>);
        } catch {
          return active;
        }
      },
    },
  };
}
