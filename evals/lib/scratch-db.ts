import { existsSync } from "node:fs";
import { Pool } from "pg";
import { runMigrations } from "../../src/db/migrate";
import { parseCreatedAt, pidIsDead } from "../../src/test/test-db";

/*
 * T-53-2 (B-460, architect rulings A9-A16): `pnpm evals` runs on its own scratch Postgres database,
 * never on the dev DB. This file imports only pg, node:* and two env-free helpers (`runMigrations`,
 * `pidIsDead`/`parseCreatedAt`), so the launcher can set the environment BEFORE `src/env.ts` loads.
 * It deliberately does not use `claimTestDatabase` (fixed `invai_test_` prefix, swept by vitest runs)
 * nor `db/reset`'s `ensureDatabase` (reuses an existing database and swallows errors).
 */

export const EVAL_DB_RE = /^invai_evals_\d{14}_\d+$/;
/** Valkey DB reserved for eval runs (A16); env.ts allows 10-14 outside tests. */
export const EVAL_REDIS_DB = 14;
const STALE_AGE_MS = 60 * 60 * 1000;

export function scratchName(pid = process.pid, now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  return `invai_evals_${stamp}_${pid}`;
}

function dbNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

function withDatabaseName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

/**
 * Fail closed (AC3): the database an eval run writes to must be an `invai_evals_<stamp>_<pid>`
 * scratch name and must differ from `invai` and from every name in `forbidden` (the raw dev URLs).
 */
export function assertEvalDatabase(url: string, forbidden: string[] = []): void {
  const name = dbNameOf(url);
  const forbiddenNames = forbidden.map((f) => (f.includes("/") ? dbNameOf(f) : f));
  if (!EVAL_DB_RE.test(name) || name === "invai" || forbiddenNames.includes(name)) {
    throw new Error(
      `refusing to run evals on "${name}": eval runs only write to an ${"invai_evals_<yyyymmddHHMMSS>_<pid>"} scratch database`,
    );
  }
}

/** main.ts calls this on the env it resolved, before it creates any tenant (A11). */
export function assertEvalEnv(databaseUrl: string, migrationDatabaseUrl: string): void {
  assertEvalDatabase(databaseUrl);
  assertEvalDatabase(migrationDatabaseUrl);
}

/** Same loading rule as `src/env.ts` (never overwrites, never logs a value). */
function loadDotenv(): void {
  if (process.env.NODE_ENV === "production" || process.env.INVAI_SKIP_DOTENV) return;
  for (const file of [".env", ".env.local"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

function evalRedisUrl(raw: string): string {
  const u = new URL(raw);
  u.pathname = `/${EVAL_REDIS_DB}`;
  u.searchParams.delete("db");
  return u.toString();
}

async function dropDatabase(adminPool: Pool, name: string): Promise<void> {
  if (!EVAL_DB_RE.test(name)) throw new Error(`refusing to drop "${name}"`);
  await adminPool
    .query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [name],
    )
    .catch(() => {});
  await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`);
}

/** Drops `invai_evals_*` databases whose pid is dead and whose marker is over an hour old (A12). */
async function sweepStale(adminPool: Pool, ownName: string): Promise<void> {
  const { rows } = await adminPool.query<{ datname: string; comment: string | null }>(
    `select d.datname, shobj_description(d.oid, 'pg_database') as comment
     from pg_database d where d.datname ~ '^invai_evals_[0-9]{14}_[0-9]+$'`,
  );
  const now = Date.now();
  for (const row of rows) {
    if (row.datname === ownName) continue;
    const pid = Number(row.datname.slice(row.datname.lastIndexOf("_") + 1));
    const createdAt = parseCreatedAt(row.comment);
    if (createdAt === null) continue; // no marker: not ours to guess
    if (now - createdAt > STALE_AGE_MS && pidIsDead(pid)) {
      await dropDatabase(adminPool, row.datname).catch((err) =>
        console.warn(`[evals] could not sweep ${row.datname}: ${(err as Error).message}`),
      );
    }
  }
}

export type ScratchContext = {
  name: string;
  databaseUrl: string;
  migrationDatabaseUrl: string;
};

export type ScratchOptions = {
  /** Raw (dev) app and owner URLs. Default: DATABASE_URL / MIGRATION_DATABASE_URL after .env loads. */
  appUrl?: string;
  migrationUrl?: string;
  name?: string;
  migrate?: (migrationDatabaseUrl: string) => Promise<void>;
  /** Launcher only: load .env, point DATABASE_URL, MIGRATION_DATABASE_URL and REDIS_URL at the scratch targets. */
  applyEnv?: boolean;
  /** Closes the pools the body opened; runs before the drop on a signal. */
  onSignalCleanup?: () => Promise<void>;
};

/**
 * Creates the scratch database, runs `body`, and drops it on every exit: normal return, a throw, and
 * SIGINT/SIGTERM (exit 130/143). The name check runs before CREATE, so a bad name writes nothing.
 */
export async function runInScratch<T>(
  body: (ctx: ScratchContext) => Promise<T>,
  opts: ScratchOptions = {},
): Promise<T> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("refusing to run evals under NODE_ENV=production");
  }
  const applyEnv = opts.applyEnv ?? false;
  if (applyEnv) loadDotenv();
  const rawApp = opts.appUrl ?? process.env.DATABASE_URL;
  const rawMigration = opts.migrationUrl ?? process.env.MIGRATION_DATABASE_URL;
  if (!rawApp || !rawMigration) {
    throw new Error("DATABASE_URL and MIGRATION_DATABASE_URL are required to run evals");
  }
  const name = opts.name ?? scratchName();
  const databaseUrl = withDatabaseName(rawApp, name);
  const migrationDatabaseUrl = withDatabaseName(rawMigration, name);
  const dev = [rawApp, rawMigration];
  assertEvalDatabase(databaseUrl, dev);
  assertEvalDatabase(migrationDatabaseUrl, dev);

  const adminUrl = withDatabaseName(rawMigration, "postgres");
  const owner = decodeURIComponent(new URL(rawMigration).username).replace(/"/g, '""');
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  let created = false;
  let dropping: Promise<void> | null = null;
  const dropOnce = () => {
    dropping ??= (async () => {
      try {
        if (created) await dropDatabase(admin, name);
      } finally {
        await admin.end().catch(() => {});
      }
    })();
    return dropping;
  };

  const onSignal = (code: number) => () => {
    void (async () => {
      await opts.onSignalCleanup?.().catch(() => {});
      await dropOnce().catch((err) => console.error(`[evals] could not drop ${name}:`, err));
      process.exit(code);
    })();
  };
  const onInt = onSignal(130);
  const onTerm = onSignal(143);
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);

  try {
    await sweepStale(admin, name);
    await admin.query(`CREATE DATABASE "${name}" OWNER "${owner}"`);
    created = true;
    await admin.query(`GRANT ALL ON DATABASE "${name}" TO invai_app`);
    await admin.query(`COMMENT ON DATABASE "${name}" IS 'created_at:${Date.now()}'`);
    // The environment is pointed at the scratch targets BEFORE migrating: `runMigrations` ends in
    // `ensureReferenceData`, which dynamically imports billing/service and with it `src/env.ts`
    // (the architect's ruling A9 assumed it was env-free; it is not).
    if (applyEnv) {
      process.env.DATABASE_URL = databaseUrl;
      process.env.MIGRATION_DATABASE_URL = migrationDatabaseUrl;
      if (process.env.REDIS_URL) process.env.REDIS_URL = evalRedisUrl(process.env.REDIS_URL);
      console.log(`Eval scratch database: ${name} (Valkey DB ${EVAL_REDIS_DB})`);
    }
    await (opts.migrate ?? ((url) => runMigrations(url, { quiet: true })))(migrationDatabaseUrl);
    return await body({ name, databaseUrl, migrationDatabaseUrl });
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    await dropOnce().catch((err) => console.error(`[evals] could not drop ${name}:`, err));
  }
}
