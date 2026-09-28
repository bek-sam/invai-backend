import { describe, expect, it } from "vitest";
import { env } from "../env";
import { hmacHex, signPayload } from "./crypto";
import {
  LINK_TTL_DAYS,
  linkSigningKey,
  safeWebPath,
  signLink,
  signLinkToken,
  verifyLinkToken,
} from "./links";

const A = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const U2 = "33333333-3333-4333-8333-333333333333";

describe("signed email links (ADR 0016)", () => {
  it("round-trips a token and points at BETTER_AUTH_URL /l/", () => {
    const url = signLink({ kind: "unsubscribe", companyId: A, userId: U, ref: "digest" });
    expect(url.startsWith(`${env.BETTER_AUTH_URL}/l/`)).toBe(true);
    const token = url.split("/l/")[1] as string;
    expect(verifyLinkToken(token)).toMatchObject({
      v: 1,
      k: "unsubscribe",
      c: A,
      u: U,
      r: "digest",
    });
  });

  it("is deterministic within a day, so header and footer links match", () => {
    const now = Date.UTC(2026, 8, 28, 3, 0, 0);
    const a = signLinkToken({ kind: "unsubscribe", companyId: A, userId: U, ref: "digest" }, now);
    const b = signLinkToken(
      { kind: "unsubscribe", companyId: A, userId: U, ref: "digest" },
      now + 5 * 3_600_000,
    );
    expect(a).toBe(b);
    const exp = verifyLinkToken(a, now)?.exp as number;
    expect(exp * 1000 - Date.UTC(2026, 8, 28)).toBe(LINK_TTL_DAYS.unsubscribe * 86_400_000);
  });

  it("rejects tampering: edited payload, wrong key, edited signature", () => {
    const good = signLinkToken({ kind: "unsubscribe", companyId: A, userId: U, ref: "digest" });
    const [body, sig] = good.split(".") as [string, string];
    // Payload edited to another person, signature kept.
    const edited = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), u: U2 }),
    ).toString("base64url");
    expect(verifyLinkToken(`${edited}.${sig}`)).toBeNull();
    // Signed with BETTER_AUTH_SECRET itself (the floor-session key), not the purpose-bound key.
    const wrongKey = signPayload(env.BETTER_AUTH_SECRET, {
      v: 1,
      k: "unsubscribe",
      c: A,
      u: U,
      r: "digest",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(verifyLinkToken(wrongKey)).toBeNull();
    expect(linkSigningKey()).toBe(hmacHex(env.BETTER_AUTH_SECRET, "links:v1"));
    // Last characters of the signature changed.
    expect(verifyLinkToken(`${good.slice(0, -4)}xxxx`)).toBeNull();
    expect(verifyLinkToken("")).toBeNull();
    expect(verifyLinkToken("not-a-token")).toBeNull();
  });

  it("rejects expired tokens, unknown versions and kinds, bad ids and long refs", () => {
    const now = Date.now();
    const click = signLinkToken({ kind: "click", companyId: A, userId: U, ref: "x" }, now);
    expect(verifyLinkToken(click, now)).not.toBeNull();
    expect(verifyLinkToken(click, now + (LINK_TTL_DAYS.click + 2) * 86_400_000)).toBeNull();
    const key = linkSigningKey();
    const base = { k: "click", c: A, u: U, r: "x", exp: Math.floor(now / 1000) + 3600 };
    expect(verifyLinkToken(signPayload(key, { ...base, v: 2 }))).toBeNull();
    expect(verifyLinkToken(signPayload(key, { ...base, v: 1, k: "reset" }))).toBeNull();
    expect(verifyLinkToken(signPayload(key, { ...base, v: 1, c: "not-a-uuid" }))).toBeNull();
    expect(verifyLinkToken(signPayload(key, { ...base, v: 1, r: "r".repeat(129) }))).toBeNull();
    expect(verifyLinkToken(signPayload(key, { ...base, v: 1, exp: "soon" }))).toBeNull();
    expect(() => signLinkToken({ kind: "click", companyId: A, userId: U, ref: "" })).toThrow();
    expect(() =>
      signLinkToken({ kind: "click", companyId: "nope", userId: U, ref: "x" }),
    ).toThrow();
  });

  it("safeWebPath keeps plain same-origin paths and turns anything else into /", () => {
    expect(safeWebPath("/digests/2026-W39")).toBe("/digests/2026-W39");
    expect(safeWebPath("/orders?filter=overdue#top")).toBe("/orders?filter=overdue#top");
    for (const bad of [
      "//evil.test/x",
      "/\\evil.test",
      "https://evil.test",
      "javascript:alert(1)",
      "/foo\\bar",
      "/a b",
      "/a\nb",
      "/x:y",
      "digests",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(safeWebPath(bad)).toBe("/");
    }
    // A colon after the first segment is a normal path character (`/o/1:2` is fine).
    expect(safeWebPath("/o/1:2")).toBe("/o/1:2");
  });
});
