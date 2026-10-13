import { claimTestRedisDb } from "./test-redis";

/**
 * Child process for the claim tests (T-49-3): runs the real `claimTestRedisDb` against a test
 * prefix and a test registry DB, prints `CLAIMED <db> <token>`, then waits. It never calls the
 * clean-up. Configuration comes from `CLAIMER_*` variables so the parent controls everything.
 */
async function main() {
  const num = (name: string) => (process.env[name] ? Number(process.env[name]) : undefined);
  const claim = await claimTestRedisDb({
    baseUrl: process.env.CLAIMER_BASE_URL as string,
    registryDb: num("CLAIMER_REGISTRY_DB"),
    keyPrefix: process.env.CLAIMER_PREFIX,
    minDb: num("CLAIMER_MIN"),
    maxDb: num("CLAIMER_MAX"),
    ttlMs: num("CLAIMER_TTL_MS"),
    heartbeatMs: num("CLAIMER_HEARTBEAT_MS"),
    reapWaitMs: num("CLAIMER_REAP_WAIT_MS"),
    reapPollMs: 100,
  });
  console.log(`CLAIMED ${claim.db} ${claim.descriptor?.token}`);
  process.stdin.on("data", (d) => {
    if (String(d).includes("release")) void claim.cleanup().then(() => process.exit(0));
  });
  // Keep the event loop alive without depending on the (unref'd) heartbeat timer.
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error(`CLAIM_FAILED ${(err as Error).message}`);
  process.exit(3);
});
