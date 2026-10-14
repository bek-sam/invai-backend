import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertScaleSeedEnv,
  insideRepoFolder,
  type ScaleSeedEnv,
  scaleSeedEnvFrom,
  valkeyDb,
} from "./guard";

/* Spec AC8. Pure function, explicit args, in the safe-seed.test.ts style. */
const DB = (name: string) => `postgres://invai:invai@localhost:5432/${name}`;
const GOOD: ScaleSeedEnv = {
  databaseUrl: DB("invai_scale_w54_1_mid"),
  migrationDatabaseUrl: DB("invai_scale_w54_1_mid"),
  redisUrl: "redis://localhost:6379/10",
  seedOutputFile: "/tmp/out.json",
};
const with_ = (patch: Partial<ScaleSeedEnv>): ScaleSeedEnv => ({ ...GOOD, ...patch });

describe("assertScaleSeedEnv", () => {
  it("accepts scratch databases, Valkey 10-13 and a set output file", () => {
    for (const db of [10, 11, 12, 13]) {
      expect(() => assertScaleSeedEnv(with_({ redisUrl: `redis://h:6379/${db}` }))).not.toThrow();
    }
  });

  it("refuses the dev database invai in DATABASE_URL", () => {
    expect(() => assertScaleSeedEnv(with_({ databaseUrl: DB("invai") }))).toThrow(/DATABASE_URL/);
  });

  it("refuses the dev database invai in MIGRATION_DATABASE_URL (both URLs are checked)", () => {
    expect(() => assertScaleSeedEnv(with_({ migrationDatabaseUrl: DB("invai") }))).toThrow(
      /MIGRATION_DATABASE_URL/,
    );
  });

  it("refuses other names: invai_test, a lookalike without the underscore, the bare prefix", () => {
    for (const name of ["invai_test", "invai_scalex", "invai_scale_", "xinvai_scale_a", ""]) {
      expect(() => assertScaleSeedEnv(with_({ databaseUrl: DB(name) }))).toThrow(/refusing/);
      expect(() => assertScaleSeedEnv(with_({ migrationDatabaseUrl: DB(name) }))).toThrow(
        /refusing/,
      );
    }
  });

  it("refuses unset or unreadable database URLs", () => {
    expect(() => assertScaleSeedEnv(with_({ databaseUrl: undefined }))).toThrow(/not set/);
    expect(() => assertScaleSeedEnv(with_({ migrationDatabaseUrl: "not a url" }))).toThrow(
      /readable/,
    );
  });

  it.each([0, 1, 8, 9, 14, 15, 16])("refuses Valkey database %i", (db) => {
    expect(() => assertScaleSeedEnv(with_({ redisUrl: `redis://localhost:6379/${db}` }))).toThrow(
      new RegExp(`${db} is not allowed`),
    );
  });

  it("refuses a Valkey URL with no database index, a db query or a non-number", () => {
    for (const redisUrl of [
      "redis://localhost:6379",
      "redis://localhost:6379/",
      "redis://localhost:6379?db=10",
      "redis://localhost:6379/10?db=10",
      "redis://localhost:6379/ten",
      "redis://localhost:6379/10/extra",
      undefined,
    ]) {
      expect(() => assertScaleSeedEnv(with_({ redisUrl }))).toThrow(/REDIS_URL/);
    }
  });

  it("refuses a blank or missing SEED_OUTPUT_FILE", () => {
    for (const seedOutputFile of [undefined, "", "   "]) {
      expect(() => assertScaleSeedEnv(with_({ seedOutputFile }))).toThrow(/SEED_OUTPUT_FILE/);
    }
  });

  it("never echoes credentials in a refusal", () => {
    try {
      assertScaleSeedEnv(with_({ databaseUrl: "postgres://invai:hunter2@localhost/invai" }));
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain("hunter2");
    }
  });

  it("reads the process env names", () => {
    expect(
      scaleSeedEnvFrom({
        DATABASE_URL: "a",
        MIGRATION_DATABASE_URL: "b",
        REDIS_URL: "c",
        SEED_OUTPUT_FILE: "d",
      } as NodeJS.ProcessEnv),
    ).toEqual({ databaseUrl: "a", migrationDatabaseUrl: "b", redisUrl: "c", seedOutputFile: "d" });
    expect(valkeyDb("redis://x/12")).toBe(12);
  });
});

/* T-56-5 A5.2: SEED_OUTPUT_FILE must not land inside any invai-* repo folder. */
describe("SEED_OUTPUT_FILE repo-folder guard", () => {
  const WS = join(import.meta.dirname, "../../../../..");
  const tmp = mkdtempSync("/tmp/scale-guard-");
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const out = (seedOutputFile: string) => () => assertScaleSeedEnv(with_({ seedOutputFile }));

  it("refuses a path inside a repo folder, even a not-yet-existing one", () => {
    expect(out(`${WS}/invai-backend/seed-output.json`)).toThrow(/inside a repo folder/);
    expect(out(`${WS}/invai-docs/new/dir/creds.json`)).toThrow(/inside a repo folder/);
  });

  it("refuses a `..` escape that resolves back into a repo", () => {
    expect(out("/tmp/../" + WS.slice(1) + "/invai-web/creds.json")).toThrow(/inside a repo folder/);
    expect(out(`${WS}/invai-backend/../invai-floor/x.json`)).toThrow(/inside a repo folder/);
  });

  it("refuses a /tmp symlink that points into a repo folder", () => {
    symlinkSync(`${WS}/invai-backend`, join(tmp, "link"));
    expect(out(join(tmp, "link", "creds.json"))).toThrow(/inside a repo folder/);
  });

  it("refuses an upper-case spelling (case-insensitive file system)", () => {
    // a folder that does not exist yet keeps its spelling through realpath, so only the compare folds case
    expect(out(`${WS}/INVAI-Newrepo/creds.json`)).toThrow(/inside a repo folder/);
    expect(out(`${WS.toUpperCase()}/invai-docs/creds.json`)).toThrow(/inside a repo folder/);
  });

  it("still allows /tmp paths and non-repo files directly in the workspace", () => {
    expect(out("/tmp/scale-out-check/creds.json")).not.toThrow();
    expect(out(join(tmp, "creds.json"))).not.toThrow();
    expect(insideRepoFolder(`${WS}/notes.json`)).toBe(false);
  });
});
