import { beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/db/client";
import { main } from "./run";
import { makeShop } from "./testkit";

/*
 * What the runner does after a database error (wave 54 security note, M3; wave 55 B-470): it
 * prints one fixed line with the error code only, exits 1, and closes the pools. The database
 * error here comes from inside the read-only helper, after the shop lookup succeeded, and its
 * message carries a connection string with a password and a query text on purpose.
 */

vi.mock("../../src/db/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/db/client")>();
  return {
    ...mod,
    withTenantReadOnly: vi.fn(mod.withTenantReadOnly),
    closeDb: vi.fn(async () => undefined),
  };
});

const SECRET = "hunter2-secret-pw";

describe("runner after a database error (B-470)", () => {
  beforeEach(() => {
    vi.mocked(client.closeDb).mockClear();
    vi.mocked(client.withTenantReadOnly).mockReset();
  });

  it("prints exactly one fixed line with the code, exits 1, prints no report, and closes the pools once", async () => {
    const shop = await makeShop("Europe/Madrid");
    vi.mocked(client.withTenantReadOnly).mockRejectedValueOnce(
      Object.assign(
        new Error(
          `Failed query: select 1 from orders where slug = '${shop.slug}' postgres://u:${SECRET}@db.internal:5432/invai`,
        ),
        { code: "57P01" },
      ),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = await main([
        "--company",
        shop.slug,
        "--from",
        "2026-05-04",
        "--to",
        "2026-06-04",
      ]);
      expect(code).toBe(1);
      expect(err.mock.calls).toEqual([["analytics: database error (code 57P01)"]]);
      expect(log).not.toHaveBeenCalled();
      expect(JSON.stringify(err.mock.calls)).not.toContain(SECRET);
      expect(client.closeDb).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });

  it("falls back to code unknown for an error without a plain code, and still closes the pools", async () => {
    const shop = await makeShop("Europe/Madrid");
    vi.mocked(client.withTenantReadOnly).mockRejectedValueOnce(new Error(`boom ${SECRET}`));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(
        await main(["--company", shop.slug, "--from", "2026-05-04", "--to", "2026-06-04"]),
      ).toBe(1);
      expect(err.mock.calls).toEqual([["analytics: database error (code unknown)"]]);
      expect(client.closeDb).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });

  it("closes the pools after a bad --now too, and exits 2", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(
        await main([
          "--company",
          "x",
          "--from",
          "2026-05-04",
          "--to",
          "2026-06-04",
          "--now",
          "yesterday",
        ]),
      ).toBe(2);
      expect(err.mock.calls).toEqual([
        ["analytics: --now must be an ISO instant such as 2026-10-14T12:00:00Z"],
      ]);
      expect(client.closeDb).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });
});
