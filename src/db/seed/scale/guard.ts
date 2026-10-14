/*
 * Guard for the scale seed (T-54-3, spec AC8). Pure: it reads only its arguments, so it runs
 * before anything that opens a pool or a queue connection (`index.ts` imports nothing else
 * statically). Every refusal is a plain sentence that never echoes a URL (credentials).
 *
 * Rules: both database URLs name a scratch database `invai_scale_<something>`, the Valkey
 * database is 10-13 (read from the URL path alone; a `db` query or a missing index is refused),
 * and SEED_OUTPUT_FILE is set so the shared seed-output.json is never overwritten.
 */
export const SCALE_DB_PREFIX = "invai_scale_";
export const SCALE_REDIS_DBS = { min: 10, max: 13 } as const;

export type ScaleSeedEnv = {
  databaseUrl: string | undefined;
  migrationDatabaseUrl: string | undefined;
  redisUrl: string | undefined;
  seedOutputFile: string | undefined;
};

function dbName(label: string, url: string | undefined): string {
  if (!url?.trim()) throw new Error(`[seed:scale] refusing: ${label} is not set.`);
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    throw new Error(`[seed:scale] refusing: ${label} is not a readable database URL.`);
  }
  if (!name.startsWith(SCALE_DB_PREFIX) || name.length === SCALE_DB_PREFIX.length) {
    throw new Error(
      `[seed:scale] refusing: ${label} names database "${name}", not a scratch database ` +
        `starting "${SCALE_DB_PREFIX}". Create one and point both database URLs at it.`,
    );
  }
  return name;
}

export function valkeyDb(url: string | undefined): number {
  if (!url?.trim()) throw new Error("[seed:scale] refusing: REDIS_URL is not set.");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("[seed:scale] refusing: REDIS_URL is not a readable URL.");
  }
  const m = /^\/(\d+)$/.exec(u.pathname);
  if (!m || u.searchParams.has("db")) {
    throw new Error(
      "[seed:scale] refusing: REDIS_URL must end with the Valkey database in its path " +
        "(for example redis://localhost:6379/10) and use no db query.",
    );
  }
  return Number(m[1]);
}

export function assertScaleSeedEnv(env: ScaleSeedEnv): void {
  dbName("DATABASE_URL", env.databaseUrl);
  dbName("MIGRATION_DATABASE_URL", env.migrationDatabaseUrl);
  const db = valkeyDb(env.redisUrl);
  if (db < SCALE_REDIS_DBS.min || db > SCALE_REDIS_DBS.max) {
    throw new Error(
      `[seed:scale] refusing: Valkey database ${db} is not allowed. Use 10-13, one assigned to ` +
        "this run (0, 9, 14 and 15 belong to the dev stack, the gate, evals and the registry).",
    );
  }
  if (!env.seedOutputFile?.trim()) {
    throw new Error("[seed:scale] refusing: set SEED_OUTPUT_FILE=<path> for this run.");
  }
}

export function scaleSeedEnvFrom(e: NodeJS.ProcessEnv): ScaleSeedEnv {
  return {
    databaseUrl: e.DATABASE_URL,
    migrationDatabaseUrl: e.MIGRATION_DATABASE_URL,
    redisUrl: e.REDIS_URL,
    seedOutputFile: e.SEED_OUTPUT_FILE,
  };
}
