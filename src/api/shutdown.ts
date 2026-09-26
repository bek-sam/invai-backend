/**
 * Process-wide "the API is draining" signal (T-12-2, B-16). `server.ts` flips this on SIGTERM;
 * long-lived connections that can't just finish naturally (SSE in `events.ts`) await it to know
 * when to send a client a retry hint and close, instead of staying open past the drain window.
 */
let resolveShuttingDown: () => void;

/** Resolves once, when shutdown begins. Never rejects. */
export const shuttingDown: Promise<void> = new Promise((resolve) => {
  resolveShuttingDown = resolve;
});

let started = false;

/** Idempotent: safe to call more than once (SIGTERM then SIGINT, a double signal, ...). */
export function beginShutdown() {
  if (started) return;
  started = true;
  resolveShuttingDown();
}

export function isShuttingDown() {
  return started;
}
