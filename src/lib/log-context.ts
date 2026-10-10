import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Fields every log line inside a request or job carries without the call site passing them
 * (T-32-5): `requestId` (API), `queue`, `job` and `jobId` (worker), `companyId` once known.
 * The API middleware (api/app.ts) and the worker's processor (worker/index.ts) open the scope.
 */
export type LogContext = {
  requestId?: string;
  companyId?: string;
  queue?: string;
  job?: string;
  jobId?: string;
};

const store = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with these fields on every log line inside it (nested scopes inherit and override). */
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
  return store.run({ ...store.getStore(), ...fields }, fn);
}

/** Adds fields to the current scope (e.g. `companyId` after the session is resolved). */
export function setLogContext(fields: LogContext) {
  const current = store.getStore();
  if (current) Object.assign(current, fields);
}

export function logContext(): LogContext | undefined {
  return store.getStore();
}
