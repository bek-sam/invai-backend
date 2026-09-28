import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem } from "../db/client";
import { members } from "../db/schema";
import { env } from "../env";
import { registerLinkHandler, signLink, signLinkToken } from "../lib/links";
import { getEmailPreference, setEmailPreference } from "../lib/notify";
import { RATE_BUCKET_LIMITS, rateLimitKey, takeToken } from "../lib/ratelimit";
import { createCompany, createUser } from "../test/fixtures";
import { app } from "./app";

/*
 * AC4/AC5 (spec AC24, AC25): the public `/l/:token` routes. Everything goes through the real Hono
 * app with `app.request`, as a mail client or a link scanner would.
 */

const uniq = () => crypto.randomUUID().slice(0, 8);
const tokenOf = (url: string) => new URL(url).pathname.split("/l/")[1] as string;

async function optedIn() {
  const company = await createCompany({ name: `Links Tees ${uniq()}` });
  const user = await createUser(company.id, "office");
  await setEmailPreference(company.id, user.id, "digest", { on: true, source: "settings" });
  return { companyId: company.id, userId: user.id };
}

describe("POST /l/:token (one-click unsubscribe)", () => {
  it("turns the preference off with source unsubscribe_link; a repeat is a 200 no-op", async () => {
    const { companyId, userId } = await optedIn();
    const token = tokenOf(signLink({ kind: "unsubscribe", companyId, userId, ref: "digest" }));
    const rfc8058 = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    };
    const first = await app.request(`/l/${token}`, rfc8058);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(first.headers.get("cache-control")).toBe("no-store");
    const after = await getEmailPreference(companyId, userId, "digest");
    expect(after).toMatchObject({ on: false, source: "unsubscribe_link" });

    const second = await app.request(`/l/${token}`, { method: "POST" });
    expect(second.status).toBe(200);
    const again = await getEmailPreference(companyId, userId, "digest");
    expect(again).toMatchObject({ on: false, source: "unsubscribe_link" });
    expect(again.updatedAt).not.toBeNull();
  });

  it("undo restores within 24 h and is refused otherwise", async () => {
    const { companyId, userId } = await optedIn();
    const token = tokenOf(signLink({ kind: "unsubscribe", companyId, userId, ref: "digest" }));
    const undo = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ undo: true }),
    };
    // Nothing to undo yet.
    expect((await app.request(`/l/${token}`, undo)).status).toBe(409);
    expect((await app.request(`/l/${token}`, { method: "POST" })).status).toBe(200);
    const restored = await app.request(`/l/${token}`, undo);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ ok: true, undone: true });
    expect(await getEmailPreference(companyId, userId, "digest")).toMatchObject({
      on: true,
      source: "settings",
    });
    // A JSON body without undo is a plain unsubscribe.
    const plain = await app.request(`/l/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(plain.status).toBe(200);
    expect((await getEmailPreference(companyId, userId, "digest")).on).toBe(false);
  });

  it("a token for shop A edited to a person in shop B is rejected and changes nothing (AC25)", async () => {
    const a = await optedIn();
    const b = await optedIn();
    // Signed with the real key, so only the binding can stop it: A's company, B's person.
    const crossed = signLinkToken({
      kind: "unsubscribe",
      companyId: a.companyId,
      userId: b.userId,
      ref: "digest",
    });
    const res = await app.request(`/l/${crossed}`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await getEmailPreference(a.companyId, a.userId, "digest")).on).toBe(true);
    expect((await getEmailPreference(b.companyId, b.userId, "digest")).on).toBe(true);
    // And the reverse: B's company, A's person.
    const reversed = signLinkToken({
      kind: "unsubscribe",
      companyId: b.companyId,
      userId: a.userId,
      ref: "digest",
    });
    expect((await app.request(`/l/${reversed}`, { method: "POST" })).status).toBe(400);
    expect((await app.request(`/l/${reversed}`)).headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/unsubscribe?error=invalid`,
    );
    expect((await getEmailPreference(a.companyId, a.userId, "digest")).on).toBe(true);
    expect((await getEmailPreference(b.companyId, b.userId, "digest")).on).toBe(true);
  });

  it("rejects a mangled, expired or deactivated-member token, an unknown kind ref, and click via POST", async () => {
    const { companyId, userId } = await optedIn();
    const good = tokenOf(signLink({ kind: "unsubscribe", companyId, userId, ref: "digest" }));
    expect((await app.request(`/l/${good.slice(0, -3)}zzz`, { method: "POST" })).status).toBe(400);
    expect((await app.request("/l/", { method: "POST" })).status).toBe(404);

    const expired = signLinkToken(
      { kind: "unsubscribe", companyId, userId, ref: "digest" },
      Date.now() - 500 * 86_400_000,
    );
    expect((await app.request(`/l/${expired}`, { method: "POST" })).status).toBe(400);

    const badRef = signLinkToken({ kind: "unsubscribe", companyId, userId, ref: "newsletter" });
    expect((await app.request(`/l/${badRef}`, { method: "POST" })).status).toBe(400);

    const click = signLinkToken({ kind: "click", companyId, userId, ref: "digest:x" });
    expect((await app.request(`/l/${click}`, { method: "POST" })).status).toBe(405);

    await withSystem((tx) =>
      tx
        .update(members)
        .set({ status: "deactivated" })
        .where(and(eq(members.organizationId, companyId), eq(members.userId, userId))),
    );
    expect((await app.request(`/l/${good}`, { method: "POST" })).status).toBe(400);
    expect((await getEmailPreference(companyId, userId, "digest")).on).toBe(true);
  });
});

describe("GET /l/:token (never mutates a preference)", () => {
  it("unsubscribe redirects to the web confirm page with the token and changes nothing", async () => {
    const { companyId, userId } = await optedIn();
    const token = tokenOf(signLink({ kind: "unsubscribe", companyId, userId, ref: "digest" }));
    const res = await app.request(`/l/${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/unsubscribe?token=${encodeURIComponent(token)}`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await getEmailPreference(companyId, userId, "digest")).on).toBe(true);
    // Invalid or expired: the error page, no 4xx HTML on the API origin.
    const bad = await app.request(`/l/${token.slice(0, -3)}zzz`);
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toBe(`${env.WEB_ORIGIN}/unsubscribe?error=invalid`);
  });

  it("click dispatches to the registered handler and redirects only to same-origin paths", async () => {
    const { companyId, userId } = await optedIn();
    const seen: Array<{ companyId: string; userId: string; ref: string }> = [];
    registerLinkHandler("click", async (input) => {
      seen.push(input);
      if (input.ref === "evil") return { path: "//evil.test/steal" };
      if (input.ref === "none") return null;
      return { path: `/digests/${input.ref}` };
    });
    try {
      const ok = tokenOf(signLink({ kind: "click", companyId, userId, ref: "2026-W39" }));
      const res = await app.request(`/l/${ok}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${env.WEB_ORIGIN}/digests/2026-W39`);
      expect(seen).toEqual([{ companyId, userId, ref: "2026-W39" }]);

      const evil = tokenOf(signLink({ kind: "click", companyId, userId, ref: "evil" }));
      expect((await app.request(`/l/${evil}`)).headers.get("location")).toBe(`${env.WEB_ORIGIN}/`);
      const none = tokenOf(signLink({ kind: "click", companyId, userId, ref: "none" }));
      expect((await app.request(`/l/${none}`)).headers.get("location")).toBe(`${env.WEB_ORIGIN}/`);

      // Another shop's person never reaches the handler.
      const other = await optedIn();
      const crossed = signLinkToken({
        kind: "click",
        companyId,
        userId: other.userId,
        ref: "2026-W39",
      });
      const denied = await app.request(`/l/${crossed}`);
      expect(denied.headers.get("location")).toBe(`${env.WEB_ORIGIN}/unsubscribe?error=invalid`);
      expect(seen).toHaveLength(3);
    } finally {
      registerLinkHandler("click", async () => null);
    }
  });

  it("is rate limited per IP with a Retry-After header", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    const limits = RATE_BUCKET_LIMITS.links;
    expect(limits.capacity).toBe(60);
    for (let i = 0; i < limits.capacity; i++) {
      expect((await takeToken(rateLimitKey("links", ip), limits)).allowed).toBe(true);
    }
    const res = await app.request("/l/whatever", { headers: { "x-forwarded-for": ip } });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Another IP is untouched.
    const other = await app.request("/l/whatever", {
      headers: { "x-forwarded-for": "198.51.100.7" },
    });
    expect(other.status).toBe(302);
  });
});
