/*
 * Tracing bootstrap (T-32-5, B-18). Loaded before the app with `node --import` (see the start and
 * dev scripts in package.json, and `dist/lib/telemetry.js` from tsup), so the SDK is registered
 * before any module creates a queue or a worker.
 *
 * Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set in the PROCESS environment: this module runs before
 * `env.ts` reads `.env`, so a value in `.env` is not seen here. Off means nothing is imported
 * beyond this file, no exporter exists and no socket is opened.
 *
 * OTEL_SERVICE_NAME defaults to invai-api or invai-worker from the entry script's path.
 * Spans export over OTLP/HTTP to `<endpoint>/v1/traces`, after the attribute allowlist
 * (lib/tracing-sdk.ts). Outgoing `fetch` spans and `traceparent` headers go to IMAGING_URL only.
 */

export function defaultServiceName(argv: readonly string[]): string {
  const entry = argv[1] ?? "";
  if (/[/\\]worker[/\\]/.test(entry)) return "invai-worker";
  if (/[/\\]api[/\\]/.test(entry)) return "invai-api";
  return "invai-backend";
}

/** The OTLP endpoint when tracing should start, else null (unset, blank or not an http(s) URL). */
export function tracingEndpoint(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  try {
    const url = new URL(v);
    if (url.protocol === "http:" || url.protocol === "https:") return v;
  } catch {}
  console.error("[telemetry] OTEL_EXPORTER_OTLP_ENDPOINT is not an http(s) URL; tracing stays off");
  return null;
}

function imagingOrigin(): string | undefined {
  try {
    return new URL(process.env.IMAGING_URL ?? "http://localhost:8000").origin;
  } catch {
    return undefined;
  }
}

const endpoint = tracingEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
if (endpoint) {
  const { startTracing } = await import("./tracing-sdk");
  await startTracing({
    endpoint,
    serviceName: process.env.OTEL_SERVICE_NAME?.trim() || defaultServiceName(process.argv),
    propagateTo: imagingOrigin,
  });
}
