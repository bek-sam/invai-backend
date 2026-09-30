import { afterEach, describe, expect, it } from "vitest";
import { assertTestDatabase } from "./db-safety";

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
    expect(() => assertTestDatabase("postgres://invai:invai@localhost:5432/invai")).toThrow(
      /doesn't look like a test database/,
    );
  });

  it("refuses a database with no name in the URL", () => {
    expect(() => assertTestDatabase("postgres://invai:invai@localhost:5432/")).toThrow(
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
    expect(() => assertTestDatabase("postgres://invai:invai@localhost:5432/invai")).toThrow(
      /doesn't look like a test database/,
    );
  });
});
