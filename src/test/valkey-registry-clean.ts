import { Redis } from "ioredis";
import { DEFAULT_KEY_PREFIX, isLoopbackHost, REGISTRY_DB } from "./test-redis";

/**
 * Lists (dry run, the default) or removes (`--apply`) the leftover application keys in the claim
 * registry DB 15, where the retired test fallback used to leave its queue and stream keys
 * (T-49-3, B-438). It only ever targets DB 15, only on a loopback host, never removes a key that
 * starts with `test-redis-db-lock:` (the claims), and uses SCAN + UNLINK (no KEYS, no FLUSH*).
 */

export type RegistryCleanPlan = { host: string; port: string; db: number; apply: boolean };

export function planRegistryClean(
  argv: string[],
  envRedisUrl: string | undefined,
): RegistryCleanPlan {
  let apply = false;
  let url = envRedisUrl ?? "redis://localhost:6379";
  for (const a of argv) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--url=")) url = a.slice("--url=".length);
    else throw new Error(`unknown argument "${a}" (use --apply, --url=redis://localhost:6379)`);
  }
  const u = new URL(url);
  if (!isLoopbackHost(u.hostname)) {
    throw new Error(`refused: ${u.hostname} is not a loopback host`);
  }
  // The URL's own DB is ignored on purpose: this command has exactly one target.
  return { host: u.hostname, port: u.port || "6379", db: REGISTRY_DB, apply };
}

export type RegistryCleanResult = {
  total: number;
  claims: string[];
  other: number;
  removed: number;
  byPrefix: Record<string, number>;
};

export function prefixOf(key: string): string {
  const i = key.indexOf(":");
  return i < 0 ? "(no prefix)" : `${key.slice(0, i)}:`;
}

export async function runRegistryClean(
  plan: RegistryCleanPlan,
  claimPrefix: string = DEFAULT_KEY_PREFIX,
): Promise<RegistryCleanResult> {
  const r = new Redis({
    host: plan.host,
    port: Number(plan.port),
    db: plan.db,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  r.on("error", () => {});
  try {
    const result: RegistryCleanResult = {
      total: 0,
      claims: [],
      other: 0,
      removed: 0,
      byPrefix: {},
    };
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "COUNT", 1000);
      cursor = next;
      const doomed: string[] = [];
      for (const k of keys) {
        result.total++;
        if (k.startsWith(claimPrefix)) {
          result.claims.push(k);
          continue;
        }
        result.other++;
        const p = prefixOf(k);
        result.byPrefix[p] = (result.byPrefix[p] ?? 0) + 1;
        doomed.push(k);
      }
      if (plan.apply && doomed.length) result.removed += await r.unlink(...doomed);
    } while (cursor !== "0");
    return result;
  } finally {
    r.disconnect();
  }
}
