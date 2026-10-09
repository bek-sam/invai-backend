import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { Client, type ClientConfig } from "pg";
import { MIGRATION_LOCK_KEY, MIGRATION_SESSION } from "./migrate";

/*
 * Release bootstrap (T-30-2, B-59): the first of the three release steps
 * (`bootstrap-cli` -> `migrate-cli` -> `reference-seed-cli`, `invai-infra/sst.config.ts` "Migrate").
 *
 * It does only what the migrations can't: make sure the RLS-enforced app role exists and can log
 * in. Everything else stays in the migrations, which run once each:
 * - table and sequence grants, default privileges and every REVOKE (0001 and later: `audit_log`,
 *   `order_item_transitions`, `plans`, `trademark_marks`, the webhook event tables,
 *   `privacy_requests`, `market_series_cache`). Granting DML here at every release would re-open
 *   them, because those migrations never run again.
 * - role-level timeouts (0025).
 *
 * The raw `pg` client, not drizzle: a drizzle query error prints the query's params.
 */

/** The only app role the schema knows: policies, REVOKEs and 0025 name it. */
export const APP_ROLE = "invai_app";
/** The owner role migrations run as (`MIGRATION_DATABASE_URL`; RDS master username, T-30-3). */
export const OWNER_ROLE = "invai";

/** Postgres's default `scram_iterations`. */
const SCRAM_ITERATIONS = 4096;

/** A one-line, secret-free failure. The CLIs print `message` and exit 1, never a stack. */
export class ReleaseStepError extends Error {
  override name = "ReleaseStepError";
}

export type BootstrapConfig = {
  /** Owner connection (`MIGRATION_DATABASE_URL`), unchanged. */
  ownerUrl: string;
  /** Owner role name from that URL. */
  ownerRole: string;
  appRole: string;
  appPassword: string;
};

function parseUrl(value: string | undefined, name: string): URL {
  if (!value?.trim()) throw new ReleaseStepError(`${name} is not set`);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    // Never echo the value: it holds a password.
    throw new ReleaseStepError(`${name} is not a valid URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ReleaseStepError(`${name} must be a postgres:// URL`);
  }
  return url;
}

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new ReleaseStepError(`${what} is not valid URL encoding`);
  }
}

/**
 * Reads the three variables the release task gets. The app role and its password come from
 * `DATABASE_URL` (what the API and worker will log in with); `APP_DB_PASSWORD` may stand in for
 * the password, and must agree with it when both are set. Every error is one line without the
 * values.
 */
export function parseBootstrapConfig(vars: {
  MIGRATION_DATABASE_URL?: string;
  DATABASE_URL?: string;
  APP_DB_PASSWORD?: string;
}): BootstrapConfig {
  const owner = parseUrl(vars.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL");
  const app = parseUrl(vars.DATABASE_URL, "DATABASE_URL");
  const ownerRole = decode(owner.username, "MIGRATION_DATABASE_URL user");
  const appRole = decode(app.username, "DATABASE_URL user");
  if (!appRole) throw new ReleaseStepError("DATABASE_URL has no user");
  if (appRole === ownerRole) {
    throw new ReleaseStepError(
      `DATABASE_URL and MIGRATION_DATABASE_URL use the same role (${appRole}); the app role must not own the tables, or RLS does not apply`,
    );
  }
  if (appRole !== APP_ROLE) {
    throw new ReleaseStepError(
      `DATABASE_URL user must be ${APP_ROLE} (the role the RLS policies and migrations name), got ${appRole}`,
    );
  }
  const fromUrl = app.password ? decode(app.password, "DATABASE_URL password") : "";
  const fromVar = vars.APP_DB_PASSWORD?.trim() ? vars.APP_DB_PASSWORD : "";
  if (fromUrl && fromVar && fromUrl !== fromVar) {
    throw new ReleaseStepError("APP_DB_PASSWORD and the password in DATABASE_URL differ");
  }
  const appPassword = fromUrl || fromVar;
  if (!appPassword) {
    throw new ReleaseStepError("no app role password: set it in DATABASE_URL or APP_DB_PASSWORD");
  }
  // Printable ASCII only, so the verifier built here (no SASLprep) is the one Postgres and every
  // client compute for the same password.
  if (!/^[\x20-\x7e]+$/.test(appPassword)) {
    throw new ReleaseStepError("the app role password must be printable ASCII");
  }
  return { ownerUrl: owner.toString(), ownerRole, appRole, appPassword };
}

/**
 * A SCRAM-SHA-256 verifier in Postgres's stored format, computed here so the plaintext password
 * never reaches the server (or its statement log). Postgres stores a value already in this
 * format as is (`CREATE/ALTER ROLE ... PASSWORD`), whatever `password_encryption` says.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** Role attributes the app role must have, as `pg_roles` columns. */
const REQUIRED_ATTRIBUTES = {
  rolcanlogin: { want: true, sql: "LOGIN" },
  rolsuper: { want: false, sql: "NOSUPERUSER" },
  rolbypassrls: { want: false, sql: "NOBYPASSRLS" },
  rolcreatedb: { want: false, sql: "NOCREATEDB" },
  rolcreaterole: { want: false, sql: "NOCREATEROLE" },
} as const;
type Attribute = keyof typeof REQUIRED_ATTRIBUTES;
type RoleRow = Record<Attribute, boolean>;

export type BootstrapResult = {
  appRole: string;
  database: string;
  created: boolean;
  /** Attributes that were wrong and were fixed, as SQL keywords (`NOBYPASSRLS`, ...). */
  fixedAttributes: string[];
  passwordUpdated: boolean;
};

async function readRole(client: Client, role: string): Promise<RoleRow | null> {
  const res = await client.query<RoleRow>(
    "select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname = $1",
    [role],
  );
  return res.rows[0] ?? null;
}

/** Can the app role log in with `password`? Only a wrong password or a missing role is "no". */
async function canLogIn(ownerConfig: ClientConfig, cfg: BootstrapConfig): Promise<boolean> {
  const client = new Client({
    ...ownerConfig,
    user: cfg.appRole,
    password: cfg.appPassword,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch (err) {
    // 28P01 invalid_password, 28000 invalid_authorization_specification (no such role / no
    // pg_hba match). Anything else (network, CONNECT missing) is a real failure.
    const code = (err as { code?: string }).code;
    if (code === "28P01" || code === "28000") return false;
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Create or update the app role as `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, and
 * grant it `CONNECT` on the current database and `USAGE` on schema `public`. Nothing else.
 *
 * Idempotent: an existing role gets only the attributes that are wrong, and a new password only
 * when it can't already log in with the configured one. On a correct database a second run
 * changes nothing (the GRANTs are no-ops). Serialized with migrations by the same advisory lock.
 */
export async function bootstrapAppRole(cfg: BootstrapConfig): Promise<BootstrapResult> {
  const ownerConfig: ClientConfig = {
    connectionString: cfg.ownerUrl,
    connectionTimeoutMillis: 10_000,
  };
  const client = new Client(ownerConfig);
  await client.connect();
  try {
    const who = await client.query<{ current_user: string; db: string }>(
      "select current_user, current_database() as db",
    );
    const { current_user: currentUser, db: database } = who.rows[0] as {
      current_user: string;
      db: string;
    };
    if (currentUser !== OWNER_ROLE) {
      throw new ReleaseStepError(
        `bootstrap must run as the owner role ${OWNER_ROLE}, connected as ${currentUser}`,
      );
    }
    const role = client.escapeIdentifier(cfg.appRole);

    let created = false;
    const fixedAttributes: string[] = [];
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL statement_timeout = 0");
      await client.query(`SET LOCAL lock_timeout = '${MIGRATION_SESSION.lockWait}'`);
      await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const existing = await readRole(client, cfg.appRole);
      if (!existing) {
        const attrs = Object.values(REQUIRED_ATTRIBUTES).map((a) => a.sql);
        await client.query(
          `CREATE ROLE ${role} ${attrs.join(" ")} PASSWORD ${client.escapeLiteral(scramVerifier(cfg.appPassword))}`,
        );
        created = true;
      } else {
        // Only what differs: naming SUPERUSER/BYPASSRLS at all needs those attributes on RDS.
        for (const [col, a] of Object.entries(REQUIRED_ATTRIBUTES)) {
          if (existing[col as Attribute] !== a.want) fixedAttributes.push(a.sql);
        }
        if (fixedAttributes.length) {
          await client.query(`ALTER ROLE ${role} WITH ${fixedAttributes.join(" ")}`);
        }
      }
      await client.query(
        `GRANT CONNECT ON DATABASE ${client.escapeIdentifier(database)} TO ${role}`,
      );
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }

    let passwordUpdated = false;
    if (!created && !(await canLogIn(ownerConfig, cfg))) {
      await client.query(
        `ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(scramVerifier(cfg.appPassword))}`,
      );
      passwordUpdated = true;
    }

    // Final check: what the API will rely on.
    const after = await readRole(client, cfg.appRole);
    const wrong = Object.entries(REQUIRED_ATTRIBUTES)
      .filter(([col, a]) => after?.[col as Attribute] !== a.want)
      .map(([, a]) => a.sql);
    if (wrong.length) {
      throw new ReleaseStepError(`${cfg.appRole} still lacks ${wrong.join(" ")}`);
    }
    const member = await client.query<{ ok: boolean }>(
      "select pg_has_role($1, $2, 'MEMBER') as ok",
      [cfg.appRole, currentUser],
    );
    if (member.rows[0]?.ok) {
      throw new ReleaseStepError(
        `${cfg.appRole} is a member of ${currentUser}, so it would bypass RLS; revoke that membership`,
      );
    }
    if (!(await canLogIn(ownerConfig, cfg))) {
      throw new ReleaseStepError(`${cfg.appRole} cannot log in with the configured password`);
    }
    return { appRole: cfg.appRole, database, created, fixedAttributes, passwordUpdated };
  } finally {
    await client.end().catch(() => {});
  }
}

/** Every URL-looking token and every given secret replaced, one line. */
export function redactLine(text: string, secrets: (string | undefined)[]): string {
  let out = text.split("\n")[0] ?? "";
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join("[redacted]");
  }
  return out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "[url]");
}

/**
 * Runs one release step as a CLI: prints `[<name>] <summary>` and exits 0, or prints one
 * secret-free line and exits 1. Never a stack trace: pg and drizzle errors can carry the
 * connection string or query params.
 *
 * The step closes what it opened, so the process ends by itself. A safety net exits anyway after
 * `HANDLE_GRACE_MS`, with a warning, so a stray handle (a pool or Redis client another module
 * opened at import) can never keep a release task alive, and still shows up in the log.
 */
export async function runReleaseStep(name: string, step: () => Promise<string>): Promise<void> {
  const secrets = [
    process.env.DATABASE_URL,
    process.env.MIGRATION_DATABASE_URL,
    process.env.APP_DB_PASSWORD,
    ...[process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL].flatMap((u) => {
      try {
        const p = u ? new URL(u).password : "";
        return p ? [p, decodeURIComponent(p)] : [];
      } catch {
        return [];
      }
    }),
  ];
  try {
    const summary = await step();
    console.log(`[${name}] ${summary}`);
    process.exitCode = 0;
  } catch (err) {
    const e = err as { message?: string; code?: string; cause?: { message?: string } };
    const parts = [e.message ?? String(err)];
    // Drizzle wraps the pg error: "Failed query: ..." first, the reason in `cause`.
    if (e.cause?.message) parts.push(e.cause.message);
    const detail = err instanceof ReleaseStepError ? parts[0] : parts.reverse().join(" <- ");
    console.error(
      `[${name}] failed${e.code ? ` (${e.code})` : ""}: ${redactLine(detail ?? "", secrets)}`,
    );
    process.exitCode = 1;
  }
  setTimeout(() => {
    console.error(`[${name}] warning: open handles after the step finished; exiting anyway`);
    process.exit();
  }, HANDLE_GRACE_MS).unref();
}

/** How long a finished release step may wait for its handles to close. */
export const HANDLE_GRACE_MS = 5_000;
