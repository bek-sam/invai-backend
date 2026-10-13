import { planRegistryClean, runRegistryClean } from "../src/test/valkey-registry-clean";

/** `pnpm test:valkey-registry-clean [--apply]`: see src/test/valkey-registry-clean.ts. */
async function main() {
  const plan = planRegistryClean(process.argv.slice(2), process.env.REDIS_URL);
  console.log(
    `[registry-clean] ${plan.apply ? "APPLY" : "dry run"} on ${plan.host}:${plan.port} DB ${plan.db}`,
  );
  const res = await runRegistryClean(plan);
  console.log(
    `[registry-clean] keys=${res.total} claim_keys=${res.claims.length} other=${res.other} removed=${res.removed}`,
  );
  for (const [p, n] of Object.entries(res.byPrefix).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${p} ${n}`);
  }
  if (!plan.apply && res.other > 0) console.log("[registry-clean] re-run with --apply to remove them");
}

main().catch((err) => {
  console.error(`[registry-clean] ${(err as Error).message}`);
  process.exit(1);
});
