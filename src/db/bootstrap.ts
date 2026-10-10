import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { Client } from "pg";
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
  // A replication login reads every tenant's rows from a logical slot, past RLS (S-61).
  rolreplication: { want: false, sql: "NOREPLICATION" },
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
  /** False when the server trusts the connection, so the password could not be checked. */
  passwordVerified: boolean;
};

async function readRole(client: Client, role: string): Promise<RoleRow | null> {
  const res = await client.query<RoleRow>(
    "select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication from pg_roles where rolname = $1",
    [role],
  );
  return res.rows[0] ?? null;
}

/** Plain words for the `pg_shdepend.classid` catalogs an owned object can live in. */
const OWNED_KINDS: Record<string, string> = {
  pg_class: "relation",
  pg_proc: "function",
  pg_namespace: "schema",
  pg_type: "type",
  pg_database: "database",
  pg_tablespace: "tablespace",
  pg_extension: "extension",
  pg_publication: "publication",
  pg_subscription: "subscription",
  pg_largeobject_metadata: "large object",
  pg_foreign_server: "foreign server",
  pg_foreign_data_wrapper: "foreign-data wrapper",
  pg_event_trigger: "event trigger",
  pg_language: "language",
  pg_default_acl: "pg_default_acl entry",
  pg_collation: "collation",
  pg_conversion: "conversion",
  pg_operator: "operator",
  pg_opclass: "operator class",
  pg_opfamily: "operator family",
  pg_statistic_ext: "statistics object",
  pg_ts_config: "text search configuration",
  pg_ts_dict: "text search dictionary",
};

/** A role name as SQL: bare when Postgres would keep it as is, quoted otherwise. */
const sqlName = (name: string) =>
  /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;

const listNames = (names: string[]) =>
  names.length > 5
    ? `${names.slice(0, 5).join(", ")} and ${names.length - 5} more`
    : names.join(", ");

/**
 * The channels past RLS that attributes don't cover (S-61). Bootstrap reports them and never
 * fixes them itself: a membership or an owned object was granted by someone on purpose or by
 * mistake, and an operator decides.
 * - Membership in any role (`pg_auth_members.member` = the app role): the app role gains that
 *   role's rights, whether it owns tables (owners bypass RLS), runs programs
 *   (`pg_execute_server_program`), reads everything (`pg_read_all_data`) or replicates
 *   (`rds_replication`). Roles that are members *of* the app role are fine: on PG16+ and RDS the
 *   role that creates it gets ADMIN membership in it automatically.
 * - Owning anything in this database or cluster-wide (`pg_shdepend`, `deptype = 'o'`): RLS does
 *   not apply to a table's owner, and an owned function, schema or type is a way to get one.
 */
async function rlsBypassProblems(client: Client, appRole: string, owner: string) {
  const problems: string[] = [];
  const member = await client.query<{ name: string }>(
    `select r.rolname as name
       from pg_auth_members m join pg_roles r on r.oid = m.roleid
      where m.member = (select oid from pg_roles where rolname = $1)
      order by 1`,
    [appRole],
  );
  const roles = member.rows.map((r) => r.name);
  if (roles.length) {
    problems.push(
      `${appRole} is a member of ${listNames(roles)} and would gain ${roles.length === 1 ? "its" : "their"} rights past RLS; run: REVOKE ${roles.map(sqlName).join(", ")} FROM ${sqlName(appRole)} ` +
        `(as ${owner}, this removes only grants ${owner} made; for another grantor add GRANTED BY <grantor>)`,
    );
  }
  const owned = await client.query<{ catalog: string; n: number }>(
    `select d.classid::regclass::text as catalog, count(*)::int as n
       from pg_shdepend d
      where d.refclassid = 'pg_authid'::regclass
        and d.refobjid = (select oid from pg_roles where rolname = $1)
        and d.deptype = 'o'
        and d.dbid in (0, (select oid from pg_database where datname = current_database()))
      group by 1 order by 1`,
    [appRole],
  );
  if (owned.rows.length) {
    const total = owned.rows.reduce((sum, r) => sum + r.n, 0);
    const kinds = owned.rows.map((r) => `${r.n} ${OWNED_KINDS[r.catalog] ?? r.catalog}`);
    // REASSIGN OWNED does not move default privileges (B-321): those need ALTER DEFAULT PRIVILEGES.
    const defaultAcls = owned.rows.some((r) => r.catalog === "pg_default_acl");
    const others = owned.rows.some((r) => r.catalog !== "pg_default_acl");
    const fixes = [
      ...(others ? [`REASSIGN OWNED BY ${sqlName(appRole)} TO ${sqlName(owner)}`] : []),
      ...(defaultAcls
        ? [
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${sqlName(appRole)} REVOKE ... for each pg_default_acl entry (REASSIGN OWNED does not clear them)`,
          ]
        : []),
    ];
    problems.push(
      `${appRole} owns ${total} object${total === 1 ? "" : "s"} (${kinds.join(", ")}) and bypasses RLS on what it owns; run: ${fixes.join("; then ")}`,
    );
  }
  return problems;
}

/**
 * Logs in as the app role with the configured password:
 * - `ok`: the server checked the password and accepted it;
 * - `wrong`: wrong password, or no such role;
 * - `unverified`: the server let the connection in without checking any password (`trust` in
 *   pg_hba, as local Docker images do for 127.0.0.1). `system_user` (Postgres 16+) is null then.
 *   RDS always checks passwords.
 */
export async function checkLogin(cfg: BootstrapConfig): Promise<"ok" | "wrong" | "unverified"> {
  // Same host, port, database and options as the owner URL, other credentials. They go into the
  // URL itself: node-postgres lets `connectionString` override a separate `user`/`password`.
  const url = new URL(cfg.ownerUrl);
  url.username = encodeURIComponent(cfg.appRole);
  url.password = encodeURIComponent(cfg.appPassword);
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const res = await client.query<{ who: string; auth: string | null }>(
      "select current_user as who, system_user as auth",
    );
    const row = res.rows[0];
    if (row?.who !== cfg.appRole) {
      throw new ReleaseStepError(`login check ran as ${row?.who}, not ${cfg.appRole}`);
    }
    return row.auth ? "ok" : "unverified";
  } catch (err) {
    // 28P01 invalid_password, 28000 invalid_authorization_specification (no such role / no
    // pg_hba match). Anything else (network, CONNECT missing) is a real failure.
    const code = (err as { code?: string }).code;
    if (code === "28P01" || code === "28000") return "wrong";
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Create or update the app role as `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
 * NOREPLICATION`, and grant it `CONNECT` on the current database and `USAGE` on schema `public`.
 * Nothing else. Fails (and changes nothing more) when the role is a member of any role or owns
 * anything (`rlsBypassProblems`).
 *
 * Idempotent: an existing role gets only the attributes that are wrong, and a new password only
 * when the server rejects the configured one. On a correct database a second run changes nothing
 * (the GRANTs are no-ops). Serialized with migrations by the same advisory lock. Where the server
 * trusts the connection without a password, the password is left alone and reported unverified.
 */
export async function bootstrapAppRole(cfg: BootstrapConfig): Promise<BootstrapResult> {
  const client = new Client({ connectionString: cfg.ownerUrl, connectionTimeoutMillis: 10_000 });
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
        // Only what differs: naming SUPERUSER/BYPASSRLS/REPLICATION at all needs those
        // attributes on RDS (and on PG16+ for REPLICATION). A refused ALTER fails the step.
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
    if (!created && (await checkLogin(cfg)) === "wrong") {
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
    const problems = await rlsBypassProblems(client, cfg.appRole, currentUser);
    if (problems.length) {
      // Attribute fixes above are committed and stay; say so, since the run still fails.
      const fixed = fixedAttributes.length
        ? ` (fixed meanwhile: ${fixedAttributes.join(" ")})`
        : "";
      throw new ReleaseStepError(`${problems.join("; ")}${fixed}`);
    }
    const login = await checkLogin(cfg);
    if (login === "wrong") {
      throw new ReleaseStepError(`${cfg.appRole} cannot log in with the configured password`);
    }
    return {
      appRole: cfg.appRole,
      database,
      created,
      fixedAttributes,
      passwordUpdated,
      passwordVerified: login === "ok",
    };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Secrets shorter than this are not redacted: a 1-2 character value matches inside almost any
 * word, so replacing it turns the line into noise, and a value that short protects nothing.
 * Everything from 3 characters up that is passed in is replaced, even where that also hides a
 * role name (the local password `invai` is the owner's name too; real passwords are long).
 */
export const MIN_REDACTED_SECRET = 3;

/**
 * One line of at most 400 characters, with every given secret (`MIN_REDACTED_SECRET` characters
 * or more, longest first so a URL goes before the password inside it) and every URL-looking
 * token replaced.
 */
export function redactLine(text: string, secrets: (string | undefined)[]): string {
  let out = text.split("\n")[0] ?? "";
  const given = secrets.filter((s): s is string => !!s && s.length >= MIN_REDACTED_SECRET);
  for (const s of given.sort((a, b) => b.length - a.length)) {
    out = out.split(s).join("[redacted]");
  }
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "[url]");
  return out.length > 400 ? `${out.slice(0, 400)}...` : out;
}

type ErrorLike = {
  message?: string;
  code?: string;
  /** pg's DETAIL line: what a refused ALTER ROLE needs, for instance. */
  detail?: string;
  cause?: unknown;
  errors?: ErrorLike[];
};

/** Message and code of an error, looking inside an AggregateError (a refused connection's
 * message is empty; each address it tried is in `errors`). */
function reasonOf(err: unknown): { text: string; code?: string } {
  const e = (err ?? {}) as ErrorLike;
  const inner = e.errors?.find((x) => x?.message);
  const text = e.message || inner?.message || String(err);
  return { text: e.detail ? `${text}: ${e.detail}` : text, code: e.code || inner?.code };
}

/**
 * The line a failed release step prints: `[<name>] failed (<code>): <reason>`, redacted. Drizzle
 * wraps the pg error as "Failed query: <sql>" with the reason (and the pg or socket code) in
 * `cause`, so the reason comes first and the query is cut to its start; its params never
 * appear (they are on the next line, and only the first line is kept).
 */
export function releaseFailureLine(
  name: string,
  err: unknown,
  secrets: (string | undefined)[],
): string {
  const top = reasonOf(err);
  const cause =
    !(err instanceof ReleaseStepError) && (err as ErrorLike | undefined)?.cause
      ? reasonOf((err as ErrorLike).cause)
      : null;
  const outer = top.text.startsWith("Failed query")
    ? `${(top.text.split("\n")[0] ?? "").slice(0, 60)}...`
    : top.text;
  const detail = cause ? `${cause.text} <- ${outer}` : top.text;
  const code = top.code ?? cause?.code;
  return `[${name}] failed${code ? ` (${code})` : ""}: ${redactLine(detail, secrets)}`;
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
    console.error(releaseFailureLine(name, err, secrets));
    process.exitCode = 1;
  }
  setTimeout(() => {
    console.error(`[${name}] warning: open handles after the step finished; exiting anyway`);
    process.exit();
  }, HANDLE_GRACE_MS).unref();
}

/** How long a finished release step may wait for its handles to close. */
export const HANDLE_GRACE_MS = 5_000;
