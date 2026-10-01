import { afterEach, describe, expect, it } from "vitest";
import { assertTestDatabase } from "./db-safety";

const DEV_DB = "postgres://invai:invai@localhost:5432/invai";

describe("assertTestDatabase", () => {
  afterEach(() => {
    delete process.env.TEST_DATABASE_URL;
    delete process.env.TEST_MIGRATION_DATABASE_URL;
  });

  it('allows a database whose name contains "test"', () => {
    expect(() =>
      assertTestDatabase("postgres://invai:invai@localhost:5432/invai_test"),
    ).not.toThrow();
    expect(() =>
      assertTestDatabase("postgres://invai:invai@localhost:5432/INVAI_TEST_T23_0"),
    ).not.toThrow();
  });

  it("refuses the dev database", () => {
    expect(() => assertTestDatabase(DEV_DB)).toThrow(/doesn't look like a test database/);
  });

  it("refuses a database with no name in the URL", () => {
    expect(() => assertTestDatabase("postgres://invai:invai@localhost:5432/")).toThrow(
      /doesn't look like a test database/,
    );
  });

  it('refuses a name that merely contains the letters "test", like invai_latest', () => {
    expect(() => assertTestDatabase("postgres://invai:invai@localhost:5432/invai_latest")).toThrow(
      /doesn't look like a test database/,
    );
  });

  it('allows a URL that doesn\'t say "test" when it matches TEST_DATABASE_URL exactly', () => {
    const url = "postgres://invai:invai@localhost:5432/invai_t23_0_r2";
    process.env.TEST_DATABASE_URL = url;
    expect(() => assertTestDatabase(url)).not.toThrow();
  });

  it('allows a URL that doesn\'t say "test" when it matches TEST_MIGRATION_DATABASE_URL exactly', () => {
    const url = "postgres://invai:invai@localhost:5432/invai_t23_0_r2";
    process.env.TEST_MIGRATION_DATABASE_URL = url;
    expect(() => assertTestDatabase(url)).not.toThrow();
  });

  it("does not trust an unrelated TEST_DATABASE_URL pin for a different, non-test URL", () => {
    process.env.TEST_DATABASE_URL = "postgres://invai:invai@localhost:5432/invai_scratch_test";
    expect(() => assertTestDatabase(DEV_DB)).toThrow(/doesn't look like a test database/);
  });

  // Round 3 finding: db-safety.ts:18-20 trusted any URL that exactly matched
  // TEST_DATABASE_URL/TEST_MIGRATION_DATABASE_URL, so pinning the dev URL by mistake let the
  // truncate reach the shared dev database. Pinning the dev URL must never be trusted.
  it("refuses the dev database even when pinned via TEST_DATABASE_URL", () => {
    process.env.TEST_DATABASE_URL = DEV_DB;
    expect(() => assertTestDatabase(DEV_DB)).toThrow(/doesn't look like a test database/);
  });

  it("refuses the dev database even when pinned via TEST_MIGRATION_DATABASE_URL", () => {
    process.env.TEST_MIGRATION_DATABASE_URL = DEV_DB;
    expect(() => assertTestDatabase(DEV_DB)).toThrow(/doesn't look like a test database/);
  });

  it("refuses whatever database the raw, un-redirected DATABASE_URL points at, pinned or not", () => {
    const original = process.env.DATABASE_URL;
    const url = "postgres://invai_app:invai@localhost:5432/some_shop_prod";
    process.env.DATABASE_URL = url;
    process.env.TEST_DATABASE_URL = url;
    try {
      expect(() => assertTestDatabase(url)).toThrow(/doesn't look like a test database/);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });

  it("refuses whatever database the raw, un-redirected MIGRATION_DATABASE_URL points at, pinned or not", () => {
    const original = process.env.MIGRATION_DATABASE_URL;
    const url = "postgres://invai:invai@localhost:5432/some_shop_prod";
    process.env.MIGRATION_DATABASE_URL = url;
    process.env.TEST_MIGRATION_DATABASE_URL = url;
    try {
      expect(() => assertTestDatabase(url)).toThrow(/doesn't look like a test database/);
    } finally {
      process.env.MIGRATION_DATABASE_URL = original;
    }
  });

  it('still allows a pinned non-dev scratch DB whose name doesn\'t contain "test"', () => {
    const url = "postgres://invai:invai@localhost:5432/invai_rev_t230";
    process.env.TEST_DATABASE_URL = url;
    expect(() => assertTestDatabase(url)).not.toThrow();
  });

  it('still allows a scratch DB with "test" in its name, unpinned', () => {
    expect(() =>
      assertTestDatabase("postgres://invai:invai@localhost:5432/invai_rev_t230_test"),
    ).not.toThrow();
  });

  // B-215: `.pathname` is percent-encoded ("%69nvai" stays as written, it isn't decoded to
  // "invai" for free), so a naive comparison against the literal string "invai" lets this
  // through unless the name is decoded first.
  it("refuses a percent-encoded spelling of the dev database name", () => {
    expect(() => assertTestDatabase("postgres://invai:invai@localhost:5432/%69nvai")).toThrow(
      /doesn't look like a test database/,
    );
  });

  it("refuses a percent-encoded dev database even when pinned via TEST_DATABASE_URL", () => {
    const url = "postgres://invai:invai@localhost:5432/%69nvai";
    process.env.TEST_DATABASE_URL = url;
    expect(() => assertTestDatabase(url)).toThrow(/doesn't look like a test database/);
  });

  it("refuses a percent-encoded spelling of the raw, un-redirected DATABASE_URL's name", () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://invai_app:invai@localhost:5432/some_shop_prod";
    const url = "postgres://invai_app:invai@localhost:5432/%73ome_shop_prod";
    try {
      expect(() => assertTestDatabase(url)).toThrow(/doesn't look like a test database/);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });
});
