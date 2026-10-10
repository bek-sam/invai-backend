import { context, propagation, trace } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  type NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flushTracing, markTracingOn, registerTracingFlush, withSpan } from "./tracing";
import { AllowlistExporter, startTracing } from "./tracing-sdk";

/*
 * T-35-5: the resource carries OTEL_RESOURCE_ATTRIBUTES (envDetector only) with our service.name
 * winning, and `flushTracing` exports what a BatchSpanProcessor still buffers, within a cap.
 */

const memory = new InMemorySpanExporter();
let provider: NodeTracerProvider;
const saved = { attrs: process.env.OTEL_RESOURCE_ATTRIBUTES, name: process.env.OTEL_SERVICE_NAME };

beforeAll(async () => {
  process.env.OTEL_RESOURCE_ATTRIBUTES =
    "deployment.environment=staging,service.name=from-env,host.name=h1";
  process.env.OTEL_SERVICE_NAME = "also-from-env";
  provider = await startTracing({
    serviceName: "invai-test",
    // A batch delay far beyond the test: only an explicit flush can export.
    processor: new BatchSpanProcessor(new AllowlistExporter(memory), {
      scheduledDelayMillis: 600_000,
    }),
  });
});

afterAll(async () => {
  await provider.shutdown();
  registerTracingFlush(null);
  markTracingOn(false);
  trace.disable();
  context.disable();
  propagation.disable();
  for (const [k, v] of [
    ["OTEL_RESOURCE_ATTRIBUTES", saved.attrs],
    ["OTEL_SERVICE_NAME", saved.name],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("flushTracing", () => {
  it("exports the buffered span before returning, with the env resource and our service.name", async () => {
    await withSpan(
      "t35-5",
      { attributes: { "invai.queue": "sync", "buyer.email": "a@b.test" } },
      async () => {},
    );
    expect(memory.getFinishedSpans()).toHaveLength(0);
    await flushTracing(3_000);
    const [span] = memory.getFinishedSpans();
    expect(span?.name).toBe("t35-5");
    const res = span?.resource.attributes ?? {};
    expect(res["deployment.environment"]).toBe("staging");
    expect(res["service.name"]).toBe("invai-test");
    // envDetector only: no host or process detector output.
    expect(res["process.command_args"]).toBeUndefined();
    expect(res["process.pid"]).toBeUndefined();
    // Span attributes stay on the allowlist; resource attributes are not span attributes.
    expect(span?.attributes["invai.queue"]).toBe("sync");
    expect(span?.attributes["buyer.email"]).toBeUndefined();
    expect(span?.attributes["deployment.environment"]).toBeUndefined();
  });

  it("never waits past its cap for a flush that hangs, and never throws", async () => {
    registerTracingFlush(() => new Promise<void>(() => {}));
    const t = Date.now();
    await flushTracing(60);
    expect(Date.now() - t).toBeLessThan(1_000);
    registerTracingFlush(() => Promise.reject(new Error("collector down")));
    await expect(flushTracing(60)).resolves.toBeUndefined();
  });

  it("is a no-op when tracing is off", async () => {
    registerTracingFlush(null);
    await expect(flushTracing(60)).resolves.toBeUndefined();
  });
});
