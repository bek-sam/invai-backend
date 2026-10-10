import { trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { queues, telemetryOption } from "./queues";
import { defaultServiceName, tracingEndpoint } from "./telemetry";
import { bullmqTelemetry, currentTraceparent, tracingOn, withSpan } from "./tracing";

/* T-32-5 AC 1: with no OTEL_* in the process env, tracing is off and nothing changes. */

describe("tracing off by default", () => {
  it("the test process has no endpoint, so the bootstrap started nothing", () => {
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(tracingOn()).toBe(false);
  });

  it("queues and workers get no telemetry option; emit gets no traceparent", async () => {
    expect(bullmqTelemetry()).toBeUndefined();
    expect(telemetryOption()).toEqual({});
    expect(queues.sync.opts.telemetry).toBeUndefined();
    await withSpan("x", {}, async () => {
      expect(currentTraceparent()).toBeNull();
      expect(trace.getActiveSpan()).toBeUndefined();
    });
  });
});

describe("bootstrap settings", () => {
  it("names the service from the entry script", () => {
    expect(defaultServiceName(["node", "/app/dist/api/server.js"])).toBe("invai-api");
    expect(defaultServiceName(["node", "/repo/src/worker/index.ts"])).toBe("invai-worker");
    expect(defaultServiceName(["node", "/repo/src/db/seed/index.ts"])).toBe("invai-backend");
  });

  it("starts only on an http(s) endpoint", () => {
    expect(tracingEndpoint(undefined)).toBeNull();
    expect(tracingEndpoint("  ")).toBeNull();
    expect(tracingEndpoint("localhost:4318")).toBeNull();
    expect(tracingEndpoint("http://127.0.0.1:4318")).toBe("http://127.0.0.1:4318");
  });
});
