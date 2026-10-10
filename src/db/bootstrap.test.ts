import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../env";
import {
  APP_ROLE,
  type BootstrapConfig,
  bootstrapAppRole,
  checkLogin,
  MIN_REDACTED_SECRET,
  parseBootstrapConfig,
  ReleaseStepError,
  redactLine,
  releaseFailureLine,
  scramVerifier,
} from "./bootstrap";
import { runMigrations } from "./migrate";

const OWNER = "postgres://invai:owner-pw@db.internal:5432/invai";
const APP = "postgres://invai_app:App%40Pass%2Fword-1@proxy.internal:5432/invai";

describe("parseBootstrapConfig", () => {
  it("takes the app role and the URL-decoded password from DATABASE_URL", () => {
    const cfg = parseBootstrapConfig({ MIGRATION_DATABASE_URL: OWNER, DATABASE_URL: APP });
    expect(cfg).toMatchObject({
      ownerRole: "invai",
      appRole: APP_ROLE,
      appPassword: "App@Pass/word-1",
    });
  });

  it("accepts APP_DB_PASSWORD when DATABASE_URL has none, and refuses a disagreeing one", () => {
    const noPw = "postgres://invai_app@proxy.internal:5432/invai";
    expect(
      parseBootstrapConfig({
        MIGRATION_DATABASE_URL: OWNER,
        DATABASE_URL: noPw,
        APP_DB_PASSWORD: "from-var-1",
      }).appPassword,
    ).toBe("from-var-1");
    expect(() =>
      parseBootstrapConfig({
        MIGRATION_DATABASE_URL: OWNER,
        DATABASE_URL: APP,
        APP_DB_PASSWORD: "other-pw-1",
      }),
    ).toThrow("APP_DB_PASSWORD and the password in DATABASE_URL differ");
    expect(() =>
      parseBootstrapConfig({ MIGRATION_DATABASE_URL: OWNER, DATABASE_URL: noPw }),
    ).toThrow("no app role password");
  });

  it("refuses any app role but invai_app, and the owner role as the app role", () => {
    expect(() =>
      parseBootstrapConfig({
        MIGRATION_DATABASE_URL: OWNER,
        DATABASE_URL: "postgres://app_user:pw-12345@h/invai",
      }),
    ).toThrow("DATABASE_URL user must be invai_app");
    expect(() =>
      parseBootstrapConfig({
        MIGRATION_DATABASE_URL: OWNER,
        DATABASE_URL: "postgres://invai:pw-12345@h/invai",
      }),
    ).toThrow("use the same role (invai)");
  });

  it("refuses a non-ASCII password (no SASLprep here) and missing or malformed URLs, never echoing them", () => {
    expect(() =>
      parseBootstrapConfig({
        MIGRATION_DATABASE_URL: OWNER,
        DATABASE_URL: "postgres://invai_app:p%C3%A4ss-w0rd@h/invai",
      }),
    ).toThrow("printable ASCII");
    expect(() => parseBootstrapConfig({ DATABASE_URL: APP })).toThrow(
      "MIGRATION_DATABASE_URL is not set",
    );
    try {
      parseBootstrapConfig({
        MIGRATION_DATABASE_URL: OWNER,
        DATABASE_URL: "postgres://invai_app:Hunter2Secret@bad host/invai",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ReleaseStepError);
      expect((err as Error).message).toBe("DATABASE_URL is not a valid URL");
    }
  });
});

describe("redactLine", () => {
  it("keeps one line, drops URLs and secrets of 8+ characters", () => {
    const line = redactLine("auth failed for Hunter2Secret at postgres://u:p@h/db\nstack line", [
      "Hunter2Secret",
    ]);
    expect(line).toBe("auth failed for [redacted] at [url]");
  });

  it("redacts a short secret passed explicitly, down to the 3-character floor (B-311)", () => {
    expect(MIN_REDACTED_SECRET).toBe(3);
    expect(redactLine("user x7Pw logged in with x7Pw", ["x7Pw"])).toBe(
      "user [redacted] logged in with [redacted]",
    );
    expect(redactLine("abc and ab", ["abc"])).toBe("[redacted] and ab");
    // 1-2 characters would match inside nearly every word: left alone.
    expect(redactLine("a role named ab", ["a", "ab"])).toBe("a role named ab");
  });
});

describe("releaseFailureLine (B-311)", () => {
  /** What drizzle throws: the SQL first, params on the next line, the pg error as `cause`. */
  const drizzleError = (cause: unknown) =>
    Object.assign(
      new Error('Failed query: insert into "plans" ("key", "name") values ($1, $2)\nparams: a,b'),
      { cause },
    );

  it("puts the connection reason and its code first, not only 'Failed query'", () => {
    const refused = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
      errors: [
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }),
      ],
    });
    expect(releaseFailureLine("reference-seed", drizzleError(refused), [])).toBe(
      '[reference-seed] failed (ECONNREFUSED): connect ECONNREFUSED 127.0.0.1:1 <- Failed query: insert into "plans" ("key", "name") values ($1...',
    );
  });

  it("redacts the reason too, and never prints the query params", () => {
    const auth = Object.assign(new Error('password authentication failed for user "x7Pw"'), {
      code: "28P01",
    });
    const line = releaseFailureLine("reference-seed", drizzleError(auth), ["x7Pw"]);
    expect(line).toMatch(/^\[reference-seed\] failed \(28P01\): password authentication failed/);
    expect(line).not.toContain("x7Pw");
    expect(line).not.toContain("params");
  });

  it("ends a refused ALTER ROLE (no REPLICATION right on RDS or PG16+) as one coded line", () => {
    // What pg throws: the reason in `message`, Postgres's DETAIL line in `detail`.
    const refused = Object.assign(new Error("permission denied to alter role"), {
      code: "42501",
      detail: "Only roles with the REPLICATION attribute may change the REPLICATION attribute.",
    });
    expect(releaseFailureLine("bootstrap", refused, [])).toBe(
      "[bootstrap] failed (42501): permission denied to alter role: Only roles with the REPLICATION attribute may change the REPLICATION attribute.",
    );
  });

  it("prints a ReleaseStepError as is", () => {
    expect(
      releaseFailureLine("bootstrap", new ReleaseStepError("DATABASE_URL is not set"), []),
    ).toBe("[bootstrap] failed: DATABASE_URL is not set");
  });
});

type Session = { clientNonce: string; response: string };
type Sasl = {
  startSession(mechanisms: string[]): Session;
  continueSession(session: Session, password: string, serverData: string): Promise<void>;
  finalizeSession(session: Session, serverData: string): void;
};
// The SCRAM client node-postgres uses to log in; no types ship for this internal module.
const sasl = createRequire(import.meta.url)("pg/lib/crypto/sasl.js") as Sasl;

/** Plays the server side of SCRAM-SHA-256 against `verifier`; true when the client proves itself. */
async function serverAccepts(verifier: string, password: string): Promise<boolean> {
  const [, iterSalt = "", keys = ""] = verifier.split("$");
  const [iterations, salt] = iterSalt.split(":");
  const [storedKey, serverKey] = keys.split(":").map((k) => Buffer.from(k, "base64"));
  if (!storedKey || !serverKey) return false;
  const session = sasl.startSession(["SCRAM-SHA-256"]);
  const nonce = `${session.clientNonce}server-nonce`;
  const serverFirst = `r=${nonce},s=${salt},i=${iterations}`;
  await sasl.continueSession(session, password, serverFirst);
  const authMessage = `n=*,r=${session.clientNonce},${serverFirst},c=biws,r=${nonce}`;
  const proof = Buffer.from(session.response.split(",p=")[1] ?? "", "base64");
  const signature = createHmac("sha256", storedKey).update(authMessage).digest();
  const clientKey = Buffer.from(proof.map((b, i) => b ^ (signature[i] ?? 0)));
  if (!createHash("sha256").update(clientKey).digest().equals(storedKey)) return false;
  sasl.finalizeSession(
    session,
    `v=${createHmac("sha256", serverKey).update(authMessage).digest("base64")}`,
  );
  return true;
}

describe("scramVerifier", () => {
  it("is Postgres's stored format, never contains the password, and a SCRAM client logs in with it", async () => {
    const verifier = scramVerifier("App@Pass/word-1");
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/,
    );
    expect(verifier).not.toContain("App@Pass");
    expect(await serverAccepts(verifier, "App@Pass/word-1")).toBe(true);
    expect(await serverAccepts(verifier, "App@Pass/word-2")).toBe(false);
    expect(scramVerifier("App@Pass/word-1")).not.toBe(verifier); // random salt
  });
});

/*
 * Bootstrap against a real database. Roles are cluster-wide and this cluster is shared, so the
 * test only runs bootstrap where it must be a no-op at cluster level: it first checks that
 * invai_app already has the required attributes and logs in with the test password, and fails
 * before calling bootstrap otherwise. It then proves the role row (attributes, password
 * verifier, settings) is byte-for-byte unchanged. Creating the role and changing its password are
 * exercised on a throwaway Postgres container (card T-30-2 report).
 */
describe("bootstrapAppRole on a scratch database", () => {
  const name = `invai_test_bootstrap_${Date.now().toString(36)}`;
  const withDb = (url: string) => {
    const u = new URL(url);
    u.pathname = `/${name}`;
    return u.toString();
  };
  const ownerUrl = withDb(env.MIGRATION_DATABASE_URL);
  const appUrl = withDb(env.DATABASE_URL);
  const serverUrl = (() => {
    const u = new URL(env.MIGRATION_DATABASE_URL);
    u.pathname = "/postgres";
    return u.toString();
  })();
  let owner: Client;

  async function roleRow() {
    const res = await owner.query(
      `select a.rolreplication, a.rolsuper, a.rolbypassrls, a.rolcreatedb, a.rolcreaterole, a.rolcanlogin, a.rolpassword,
              (select s.setconfig from pg_db_role_setting s where s.setrole = a.oid and s.setdatabase = 0) as config
         from pg_authid a where a.rolname = $1`,
      [APP_ROLE],
    );
    return res.rows[0];
  }

  beforeAll(async () => {
    const server = new Client({ connectionString: serverUrl });
    await server.connect();
    // Owned by invai with no extra grant, unlike `ensureDatabase`, so CONNECT is bootstrap's.
    await server.query(`CREATE DATABASE "${name}"`);
    await server.end();
    owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    const server = new Client({ connectionString: serverUrl });
    await server.connect();
    await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await server.end();
  });

  it("bootstrap -> migrate -> bootstrap: grants CONNECT and USAGE only, never re-opens a REVOKE, changes no role", async () => {
    // Precondition guard: refuse to run bootstrap where it would change the shared role.
    const before = await roleRow();
    expect(before).toMatchObject({
      rolreplication: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: true,
    });
    const probe = new Client({ connectionString: withDb(env.DATABASE_URL) });
    await probe.connect(); // PUBLIC has CONNECT on a new database; the password must already work.
    await probe.end();

    const cfg = parseBootstrapConfig({ MIGRATION_DATABASE_URL: ownerUrl, DATABASE_URL: appUrl });
    const unchanged = {
      created: false,
      fixedAttributes: [],
      passwordUpdated: false,
      database: name,
    };
    expect(await bootstrapAppRole(cfg)).toMatchObject(unchanged);
    await runMigrations(ownerUrl, { quiet: true });
    expect(await bootstrapAppRole(cfg)).toMatchObject(unchanged);

    const priv = await owner.query(
      `select has_table_privilege('invai_app', 'audit_log', 'UPDATE') as audit_update,
              has_table_privilege('invai_app', 'audit_log', 'DELETE') as audit_delete,
              has_table_privilege('invai_app', 'audit_log', 'INSERT') as audit_insert,
              has_table_privilege('invai_app', 'order_item_transitions', 'UPDATE') as transitions_update,
              has_table_privilege('invai_app', 'plans', 'INSERT') as plans_insert,
              has_table_privilege('invai_app', 'trademark_marks', 'UPDATE') as marks_update,
              has_table_privilege('invai_app', 'privacy_requests', 'UPDATE') as privacy_update,
              has_database_privilege('invai_app', current_database(), 'CONNECT') as can_connect,
              has_database_privilege('invai_app', current_database(), 'CREATE') as can_create,
              has_schema_privilege('invai_app', 'public', 'USAGE') as schema_usage,
              has_schema_privilege('invai_app', 'public', 'CREATE') as schema_create`,
    );
    expect(priv.rows[0]).toEqual({
      audit_update: false,
      audit_delete: false,
      audit_insert: true,
      transitions_update: false,
      plans_insert: false,
      marks_update: false,
      privacy_update: false,
      can_connect: true,
      can_create: false,
      schema_usage: true,
      schema_create: false,
    });
    expect(await roleRow()).toEqual(before);

    // RLS applies to the app role: a tenant row the owner wrote is invisible without a tenant.
    const company = await owner.query<{ id: string }>(
      "insert into companies (name, slug) values ('Bootstrap Test', $1) returning id",
      [`bootstrap-${name}`],
    );
    const companyId = company.rows[0]?.id;
    await owner.query("insert into locations (company_id, name) values ($1, 'Main')", [companyId]);
    const app = new Client({ connectionString: appUrl });
    await app.connect();
    try {
      const none = await app.query("select id from locations");
      expect(none.rowCount).toBe(0);
      await app.query("begin");
      await app.query("select set_config('app.company_id', $1, true)", [companyId]);
      const mine = await app.query("select id from locations");
      await app.query("commit");
      expect(mine.rowCount).toBe(1);
    } finally {
      await app.end();
    }
  }, 120_000);

  it("checks the login as the app role itself, and reports a wrong password", async () => {
    const cfg = parseBootstrapConfig({ MIGRATION_DATABASE_URL: ownerUrl, DATABASE_URL: appUrl });
    // "ok" where the server checks passwords (CI, RDS), "unverified" where it trusts the host.
    expect(["ok", "unverified"]).toContain(await checkLogin(cfg));
    const wrong = await checkLogin({ ...cfg, appPassword: "not-the-password-1" });
    // A trusting server lets any password in; only a checking one must say "wrong".
    expect(["wrong", "unverified"]).toContain(wrong);
  });

  it("refuses to run as any role but the owner, before changing anything", async () => {
    const cfg: BootstrapConfig = {
      ownerUrl: appUrl,
      ownerRole: "invai",
      appRole: APP_ROLE,
      appPassword: new URL(appUrl).password,
    };
    await expect(bootstrapAppRole(cfg)).rejects.toThrow(
      "bootstrap must run as the owner role invai, connected as invai_app",
    );
  });
});

/*
 * S-61 (B-313): the channels past RLS that role attributes don't cover. These run against a
 * scratch role of their own, never `invai_app`: roles are cluster-wide and this cluster is
 * shared. `bootstrapAppRole` takes the role from its config (only `parseBootstrapConfig` pins it
 * to invai_app), so the checks are the same ones the release runs. The scratch role, its helper
 * role and the scratch database are dropped afterwards.
 */
describe("bootstrapAppRole refuses every RLS-bypass channel (S-61)", () => {
  const tag = Date.now().toString(36);
  const name = `invai_test_bsdrift_${tag}`;
  const appRole = `invai_test_app_${tag}`;
  const helperRole = `invai_test_tblowner_${tag}`;
  const appPassword = `S61-test-pw-${tag}`;
  const at = (url: string, db: string) => {
    const u = new URL(url);
    u.pathname = `/${db}`;
    return u.toString();
  };
  const ownerUrl = at(env.MIGRATION_DATABASE_URL, name);
  const serverUrl = at(env.MIGRATION_DATABASE_URL, "postgres");
  const cfg: BootstrapConfig = { ownerUrl, ownerRole: "invai", appRole, appPassword };
  const unchanged = { created: false, fixedAttributes: [], passwordUpdated: false };
  let owner: Client;
  const sql = (text: string) => owner.query(text);

  beforeAll(async () => {
    const server = new Client({ connectionString: serverUrl });
    await server.connect();
    await server.query(`CREATE DATABASE "${name}"`);
    await server.query(
      `CREATE ROLE ${appRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${appPassword}'`,
    );
    await server.query(`CREATE ROLE ${helperRole} NOLOGIN`);
    await server.end();
    owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    const server = new Client({ connectionString: serverUrl });
    await server.connect();
    await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await server.query(`DROP ROLE IF EXISTS ${appRole}`);
    await server.query(`DROP ROLE IF EXISTS ${helperRole}`);
    await server.end();
  });

  it("clean role: unchanged, rc 0 path", async () => {
    expect(await bootstrapAppRole(cfg)).toMatchObject({ ...unchanged, database: name });
  });

  it("a role that is a member OF the app role (PG16+/RDS creator's ADMIN grant) still passes", async () => {
    await sql(`GRANT ${appRole} TO invai WITH ADMIN OPTION`);
    try {
      expect(await bootstrapAppRole(cfg)).toMatchObject(unchanged);
    } finally {
      await sql(`REVOKE ${appRole} FROM invai`);
    }
  });

  it("REPLICATION: sets NOREPLICATION, reports it, and the next run is unchanged", async () => {
    await sql(`ALTER ROLE ${appRole} REPLICATION`);
    try {
      expect(await bootstrapAppRole(cfg)).toMatchObject({ fixedAttributes: ["NOREPLICATION"] });
      const row = await sql(`select rolreplication from pg_roles where rolname = '${appRole}'`);
      expect(row.rows[0]).toEqual({ rolreplication: false });
      expect(await bootstrapAppRole(cfg)).toMatchObject(unchanged);
    } finally {
      await sql(`ALTER ROLE ${appRole} NOREPLICATION`);
    }
  });

  it("member of any role: fails naming the roles and the REVOKE, and revokes nothing itself", async () => {
    await sql(`GRANT ${helperRole}, pg_read_all_data TO ${appRole}`);
    try {
      const err = await bootstrapAppRole(cfg).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ReleaseStepError);
      expect((err as Error).message).toBe(
        `${appRole} is a member of ${helperRole}, pg_read_all_data and would gain their rights past RLS; run: REVOKE ${helperRole}, pg_read_all_data FROM ${appRole}`,
      );
      const still = await sql(
        `select count(*)::int as n from pg_auth_members where member = '${appRole}'::regrole`,
      );
      expect(still.rows[0]).toEqual({ n: 2 });
    } finally {
      await sql(`REVOKE ${helperRole}, pg_read_all_data FROM ${appRole}`);
    }
  });

  it("member of a role and REPLICATION: still fails, and says the attribute was fixed", async () => {
    await sql(`GRANT ${helperRole} TO ${appRole}`);
    await sql(`ALTER ROLE ${appRole} REPLICATION`);
    try {
      await expect(bootstrapAppRole(cfg)).rejects.toThrow(
        `would gain its rights past RLS; run: REVOKE ${helperRole} FROM ${appRole} (fixed meanwhile: NOREPLICATION)`,
      );
    } finally {
      await sql(`REVOKE ${helperRole} FROM ${appRole}`);
      await sql(`ALTER ROLE ${appRole} NOREPLICATION`);
    }
  });

  it("owns anything (any kind): fails naming count and kinds", async () => {
    await sql(`CREATE SCHEMA s61_${tag} AUTHORIZATION ${appRole}`);
    await sql("CREATE TABLE s61_owned (x int)");
    await sql(`ALTER TABLE s61_owned OWNER TO ${appRole}`);
    await sql("CREATE FUNCTION s61_fn() RETURNS int LANGUAGE sql AS 'select 1'");
    await sql(`ALTER FUNCTION s61_fn() OWNER TO ${appRole}`);
    try {
      await expect(bootstrapAppRole(cfg)).rejects.toThrow(
        `${appRole} owns 3 objects (1 relation, 1 schema, 1 function) and bypasses RLS on what it owns; run: REASSIGN OWNED BY ${appRole} TO invai`,
      );
    } finally {
      await sql(`DROP SCHEMA s61_${tag}`);
      await sql("DROP TABLE s61_owned");
      await sql("DROP FUNCTION s61_fn()");
    }
  });
});
