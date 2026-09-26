/**
 * Race an async cleanup against a hard cap (T-12-2, B-16). Used by `api/server.ts` (draining HTTP
 * connections on SIGTERM) and `worker/index.ts` (draining BullMQ workers) so a stuck request or a
 * long-running job can't hold the process open past a deploy's real stop-timeout budget.
 *
 * Below the cap, `work` settles normally and this resolves `true`. At the cap, this resolves
 * `false` immediately -- `work` is not cancelled, only no longer waited on, so the caller can
 * force-exit while it's still running.
 */
export function withShutdownCap(work: Promise<unknown>, capMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const cap = setTimeout(() => resolve(false), capMs);
    work
      .catch(() => {
        // The caller decides what a failed cleanup means; this race only reports timing.
      })
      .then(() => {
        clearTimeout(cap);
        resolve(true);
      });
  });
}
