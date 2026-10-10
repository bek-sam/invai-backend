import { sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client";
import { errorData, isSensitiveKey, logger, logRecord, REDACTED, redact } from "./log";
import { setLogContext, withLogContext } from "./log-context";

/*
 * T-32-5 (S-29 logging part): log lines carry the request/job scope automatically, buyer and
 * secret fields are redacted at any depth, and query parameters never reach a log line.
 */

const BUYER = "maria.gonzalez@example.com";

describe("redaction", () => {
  it("redacts a nested buyer email and address, keeps ids and event names", () => {
    const out = redact({
      name: "order.imported",
      orderId: "o-1",
      stationTokenId: "t-1",
      emailVerified: true,
      shipTo: { email: BUYER, address: { street1: "1 Camelback Rd", city: "Phoenix" } },
      items: [{ personalization: { values: { line: "MARIA" } }, buyerName: "Maria" }],
    });
    expect(out).toEqual({
      name: "order.imported",
      orderId: "o-1",
      stationTokenId: "t-1",
      emailVerified: true,
      shipTo: { email: REDACTED, address: REDACTED },
      items: [{ personalization: REDACTED, buyerName: REDACTED }],
    });
  });

  it.each([
    "email",
    "buyerEmail",
    "ship_name",
    "firstName",
    "lastName",
    "fullName",
    "recipientName",
    "customerName",
    "phone",
    "street",
    "zip",
    "postalCode",
    "buyerNote",
    "values",
    "password",
    "accessToken",
    "x-api-secret",
    "authorization",
    "cookie",
    "FIELD_ENCRYPTION_KEY",
    "FIELD_ENCRYPTION_KEYRING",
    "apiKey",
  ])("redacts %s", (key) => expect(isSensitiveKey(key)).toBe(true));

  it.each(["name", "msg", "orderId", "event", "inputTokens", "capacity", "count", "emailCount"])(
    "keeps %s",
    (key) => expect(isSensitiveKey(key)).toBe(false),
  );

  it("handles cycles and depth without throwing", () => {
    const a: Record<string, unknown> = { id: 1 };
    a.self = a;
    expect(redact(a)).toEqual({ id: 1, self: "[circular]" });
  });
});

describe("log lines", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a written line has the nested buyer email as [redacted]", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    logger("t325").info("order imported", { order: { buyer: { email: BUYER } } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(REDACTED);
    expect(lines[0]).not.toContain(BUYER);
  });

  it("carries requestId and companyId from the scope without the call site passing them", () => {
    withLogContext({ requestId: "req-1" }, () => {
      setLogContext({ companyId: "co-1" });
      expect(logRecord("info", "t", "m", { orderId: "o-1" })).toMatchObject({
        requestId: "req-1",
        companyId: "co-1",
        orderId: "o-1",
      });
    });
    expect(logRecord("info", "t", "m").requestId).toBeUndefined();
  });

  it("carries queue, job and jobId in a job scope", () => {
    const line = withLogContext(
      { queue: "render", job: "production.buildSheets", jobId: "9" },
      () => logRecord("info", "t", "m"),
    );
    expect(line).toMatchObject({ queue: "render", job: "production.buildSheets", jobId: "9" });
    expect(line.traceId).toBeUndefined(); // tracing off in this file
  });
});

describe("errorData", () => {
  it("drops drizzle's params line from message and stack, keeps code and constraint", () => {
    const cause = Object.assign(new Error(`duplicate key value violates unique constraint`), {
      code: "23505",
      constraint: "users_email_key",
      detail: `Key (email)=(${BUYER}) already exists.`,
    });
    const err = new DrizzleQueryError('insert into "users" ("email") values ($1)', [BUYER], cause);
    expect(err.message).toContain(BUYER);
    const data = errorData(err);
    expect(JSON.stringify(data)).not.toContain(BUYER);
    expect(data).toMatchObject({
      error: 'Failed query: insert into "users" ("email") values ($1)',
      code: "23505",
      constraint: "users_email_key",
    });
    expect(String(data.stack)).toContain("Failed query");
    expect(String(data.stack)).toContain("    at ");
  });

  it("a real failed query against Postgres logs neither the parameter nor the pg message", async () => {
    const err = await db.execute(sql`select ${BUYER}::int`).catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain(BUYER);
    const data = errorData(err);
    expect(JSON.stringify(data)).not.toContain(BUYER);
    expect(data.code).toBe("22P02");
  });

  it("a multi-line parameter is dropped too", () => {
    const err = new DrizzleQueryError("update x set note = $1", ["line one\nline two"], undefined);
    expect(JSON.stringify(errorData(err))).not.toContain("line two");
  });

  it("plain errors are unchanged", () => {
    expect(errorData(new Error("boom")).error).toBe("boom");
    expect(errorData("text")).toEqual({ error: "text" });
  });
});
