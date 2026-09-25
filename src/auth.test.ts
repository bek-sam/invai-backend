import { createHmac } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Account security (T-2-3) through the real HTTP surface: email verification, password reset,
 * change password, sessions, and two-step sign-in (TOTP + backup codes). Mail is captured; the
 * TOTP codes come from an RFC 6238 implementation below, the way an authenticator app reads the
 * otpauth:// URI, so the test also proves the QR code works.
 */

type Sent = { to: string; subject: string; text: string; html?: string };
const mail = vi.hoisted(() => ({ sent: [] as Sent[], delayMs: 0 }));
vi.mock("./integrations/vendors/mailer", async (orig) => ({
  ...(await orig<typeof import("./integrations/vendors/mailer")>()),
  sendMail: vi.fn(async (m: Sent) => {
    if (mail.delayMs) await new Promise((r) => setTimeout(r, mail.delayMs));
    mail.sent.push(m);
    return { messageId: `<${mail.sent.length}@test>` };
  }),
}));

const { app } = await import("./api/app");
const { buildContext } = await import("./api/context");
const { auth, authOptions, EMAIL_VERIFICATION_TTL_SEC } = await import("./auth");
const { betterAuth } = await import("better-auth");
const { db, withSystem, withTenant } = await import("./db/client");
const { invitations, members, twoFactors, users, verifications } = await import("./db/schema");
const { env } = await import("./env");
const { issueStationToken, pinLogin, setPin } = await import("./modules/tenancy/floor-auth");
const { createCompany, createLocation, createStation, createUser } = await import(
  "./test/fixtures"
);

const PASSWORD = "correct horse 1";

const post = (path: string, body: unknown, cookie?: string) =>
  app.request(`/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: env.WEB_ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
const get = (path: string, cookie?: string) =>
  app.request(`/api/auth${path}`, {
    headers: { origin: env.WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
  });
const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .filter((c) => !/max-age=0/i.test(c))
    .map((c) => c.split(";")[0])
    .join("; ");

let n = 0;
const uniqEmail = (p: string) => `${p}-${Date.now()}-${n++}@test.local`;

async function signUp(email: string, extra: Record<string, unknown> = {}) {
  const res = await post("/sign-up/email", {
    email,
    password: PASSWORD,
    name: "Sec Test",
    ...extra,
  });
  expect(res.status).toBe(200);
  return cookieOf(res);
}
async function signIn(email: string, password = PASSWORD) {
  const res = await post("/sign-in/email", { email, password });
  return { res, body: (await res.json()) as Record<string, unknown>, cookie: cookieOf(res) };
}
async function sessionUser(cookie: string) {
  const res = await get("/get-session", cookie);
  const body = (await res.json()) as { user: Record<string, unknown> } | null;
  return body?.user ?? null;
}
async function mailTo(to: string, subject: RegExp, after = 0) {
  return vi.waitFor(
    () => {
      const m = mail.sent.slice(after).find((s) => s.to === to && subject.test(s.subject));
      if (!m) throw new Error(`no mail to ${to} matching ${subject}`);
      return m;
    },
    { timeout: 5_000, interval: 25 },
  );
}
const tokenIn = (m: Sent, page: string) => {
  const match = m.text.match(new RegExp(`${page}\\?token=([^\\s]+)`));
  if (!match?.[1]) throw new Error(`no ${page} link in: ${m.text}`);
  return decodeURIComponent(match[1]);
};

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from an otpauth:// URI, like an authenticator app. */
function totp(uri: string, at = Date.now()) {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  const offset = (h[h.length - 1] ?? 0) & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

describe("email verification", () => {
  it("sign-up sends an English verification link to the web app; the user can sign in unverified", async () => {
    const email = uniqEmail("verify");
    const before = mail.sent.length;
    const cookie = await signUp(email);
    const m = await mailTo(email, /Confirm your email/, before);
    expect(m.text).toContain(`${env.WEB_ORIGIN}/verify-email?token=`);
    expect(m.html).toContain(`${env.WEB_ORIGIN}/verify-email?token=`);
    expect(await sessionUser(cookie)).toMatchObject({ email, emailVerified: false });
    const { body } = await signIn(email);
    expect(body).toMatchObject({ user: { email, emailVerified: false } });
  });

  it("the link verifies the email once; reusing it changes nothing", async () => {
    const email = uniqEmail("verify-ok");
    const before = mail.sent.length;
    const cookie = await signUp(email);
    const token = tokenIn(await mailTo(email, /Confirm your email/, before), "verify-email");
    const res = await get(`/verify-email?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(await sessionUser(cookie)).toMatchObject({ emailVerified: true });
    // Verifying doesn't sign anyone in (a leaked link must not skip the password or 2FA).
    expect(cookieOf(res)).not.toContain("session_token");
    const again = await get(`/verify-email?token=${encodeURIComponent(token)}`);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: true, user: null });
  });

  it("an expired, forged or garbled token is refused", async () => {
    const email = uniqEmail("verify-bad");
    await signUp(email);
    const expired = await createEmailVerificationToken(
      env.BETTER_AUTH_SECRET,
      email,
      undefined,
      -60,
    );
    const r1 = await get(`/verify-email?token=${expired}`);
    expect(r1.status).toBe(401);
    expect(await r1.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
    const forged = await createEmailVerificationToken("x".repeat(40), email);
    const r2 = await get(`/verify-email?token=${forged}`);
    expect(await r2.json()).toMatchObject({ code: "INVALID_TOKEN" });
    const r3 = await get("/verify-email?token=garbage");
    expect(await r3.json()).toMatchObject({ code: "INVALID_TOKEN" });
    const [row] = await db.select().from(users).where(eq(users.email, email));
    expect(row?.emailVerified).toBe(false);
    expect(EMAIL_VERIFICATION_TTL_SEC).toBe(86_400);
  });

  it("the client can't mark itself verified at sign-up or with update-user", async () => {
    const email = uniqEmail("self-verify");
    const cookie = await signUp(email, { emailVerified: true, twoFactorEnabled: true });
    expect(await sessionUser(cookie)).toMatchObject({
      emailVerified: false,
      twoFactorEnabled: false,
    });
    await post("/update-user", { emailVerified: true, twoFactorEnabled: true }, cookie);
    expect(await sessionUser(cookie)).toMatchObject({
      emailVerified: false,
      twoFactorEnabled: false,
    });
  });

  it("the language set at sign-up (or later with update-user) picks the Spanish email", async () => {
    const email = uniqEmail("es");
    const before = mail.sent.length;
    const cookie = await signUp(email, { locale: "es" });
    const m = await mailTo(email, /Confirma tu correo/, before);
    expect(m.text).toContain("/verify-email?token=");
    expect(await sessionUser(cookie)).toMatchObject({ locale: "es" });
    const bad = await post("/update-user", { locale: "fr" }, cookie);
    expect(bad.status).toBe(400);
    const ok = await post("/update-user", { locale: "en" }, cookie);
    expect(ok.status).toBe(200);
    expect(await sessionUser(cookie)).toMatchObject({ locale: "en" });
  });

  it("resend answers the same for unknown, unverified and verified emails", async () => {
    const unverified = uniqEmail("resend");
    await signUp(unverified);
    const before = mail.sent.length;
    const answers = [];
    for (const email of [unverified, uniqEmail("nobody")]) {
      const res = await post("/send-verification-email", { email });
      answers.push([res.status, await res.json()]);
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toEqual([200, { status: true }]);
    await mailTo(unverified, /Confirm your email/, before);
  });

  it("an invitee is verified by accepting the invite, and gets no verification email", async () => {
    const shop = await createCompany({ name: "Invite Shop" });
    const owner = await createUser(shop.id, "owner");
    const email = uniqEmail("invitee");
    const [inv] = await db
      .insert(invitations)
      .values({
        organizationId: shop.id,
        email,
        role: "office",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: owner.id,
      })
      .returning();
    const before = mail.sent.length;
    const cookie = await signUp(email);
    expect(await sessionUser(cookie)).toMatchObject({ emailVerified: false });
    const res = await post("/organization/accept-invitation", { invitationId: inv?.id }, cookie);
    expect(res.status).toBe(200);
    expect(await sessionUser(cookie)).toMatchObject({ emailVerified: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(mail.sent.slice(before).filter((m) => m.to === email)).toEqual([]);
  });

  it("server-side sign-ups (the seed) send no email; seeded and fixture users are verified", async () => {
    const email = uniqEmail("seedlike");
    const before = mail.sent.length;
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "Seed" } });
    await new Promise((r) => setTimeout(r, 100));
    expect(mail.sent.slice(before).filter((m) => m.to === email)).toEqual([]);
    const shop = await createCompany();
    const user = await createUser(shop.id, "packer");
    expect(user.emailVerified).toBe(true);
    expect((await createUser(shop.id, "packer", { emailVerified: false })).emailVerified).toBe(
      false,
    );
  });
});

describe("password reset", () => {
  it("answers the same way whether or not the email exists, without waiting on mail", async () => {
    const email = uniqEmail("reset-same");
    await signUp(email);
    mail.delayMs = 2_000;
    try {
      const t0 = Date.now();
      const known = await post("/request-password-reset", { email });
      const knownMs = Date.now() - t0;
      const unknown = await post("/request-password-reset", { email: uniqEmail("ghost") });
      expect(known.status).toBe(unknown.status);
      expect(await known.json()).toEqual(await unknown.json());
      // The known email doesn't wait for the 2 s mail server.
      expect(knownMs).toBeLessThan(1_000);
    } finally {
      mail.delayMs = 0;
    }
    await mailTo(email, /Reset your InvAI password/);
  });

  it("the link goes to /reset-password, works once for 1 hour, and signs every session out", async () => {
    const email = uniqEmail("reset");
    const first = await signUp(email);
    const second = (await signIn(email)).cookie;
    const before = mail.sent.length;
    await post("/request-password-reset", { email });
    const m = await mailTo(email, /Reset your InvAI password/, before);
    expect(m.text).toContain(`${env.WEB_ORIGIN}/reset-password?token=`);
    const token = tokenIn(m, "reset-password");
    const [row] = await db
      .select()
      .from(verifications)
      .where(eq(verifications.identifier, `reset-password:${token}`));
    const ttl = (row?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(59 * 60_000);
    expect(ttl).toBeLessThanOrEqual(60 * 60_000);

    const res = await post("/reset-password", { token, newPassword: "new horse battery 2" });
    expect(res.status).toBe(200);
    expect(await sessionUser(first)).toBeNull();
    expect(await sessionUser(second)).toBeNull();
    expect((await signIn(email)).res.status).toBe(401);
    expect((await signIn(email, "new horse battery 2")).res.status).toBe(200);
    await mailTo(email, /password was changed/, before);
    // The link reached the inbox, so the email now counts as verified.
    expect((await db.select().from(users).where(eq(users.email, email)))[0]?.emailVerified).toBe(
      true,
    );

    const reuse = await post("/reset-password", { token, newPassword: "third horse 333" });
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("an expired reset link is refused", async () => {
    const email = uniqEmail("reset-expired");
    await signUp(email);
    const before = mail.sent.length;
    await post("/request-password-reset", { email });
    const token = tokenIn(
      await mailTo(email, /Reset your InvAI password/, before),
      "reset-password",
    );
    await db
      .update(verifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verifications.identifier, `reset-password:${token}`));
    const res = await post("/reset-password", { token, newPassword: "new horse battery 2" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_TOKEN" });
    expect((await signIn(email)).res.status).toBe(200);
  });

  it("floor PIN sessions keep working through a reset", async () => {
    const email = uniqEmail("floor");
    await signUp(email);
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const userId = user?.id as string;
    const shop = await createCompany();
    const owner = await createUser(shop.id, "owner");
    const location = await createLocation(shop.id);
    const station = await createStation(shop.id, location.id);
    await withSystem((tx) =>
      tx.insert(members).values({ organizationId: shop.id, userId, role: "presser" }),
    );
    const stationToken = await withTenant(shop.id, async (tx) => {
      await setPin(tx, { companyId: shop.id, userId, pin: "4321", actorUserId: owner.id });
      return (
        await issueStationToken(tx, { companyId: shop.id, stationId: station.id, userId: owner.id })
      ).token;
    });
    const floor = await pinLogin({ stationToken, pin: "4321", ip: null });
    const before = mail.sent.length;
    await post("/request-password-reset", { email });
    const token = tokenIn(
      await mailTo(email, /Reset your InvAI password/, before),
      "reset-password",
    );
    expect((await post("/reset-password", { token, newPassword: "floor horse 22" })).status).toBe(
      200,
    );
    const ctx = await buildContext(
      new Request("http://x/api/v1/floor/me", {
        headers: { authorization: `Bearer ${floor.token}` },
      }),
    );
    expect(ctx).toMatchObject({ sessionKind: "floor", user: { id: userId } });
  });
});

describe("change password and sessions", () => {
  it("needs the current password and always signs the other sessions out", async () => {
    const email = uniqEmail("change");
    const mine = await signUp(email);
    const other = (await signIn(email)).cookie;
    const wrong = await post(
      "/change-password",
      { currentPassword: "not it at all", newPassword: "brand new pass 1" },
      mine,
    );
    expect(wrong.status).toBe(400);
    expect(await sessionUser(other)).not.toBeNull();

    const before = mail.sent.length;
    const res = await post(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: "brand new pass 1", revokeOtherSessions: false },
      mine,
    );
    expect(res.status).toBe(200);
    const fresh = cookieOf(res);
    expect(await sessionUser(other)).toBeNull();
    expect(await sessionUser(fresh)).toMatchObject({ email });
    expect((await signIn(email, "brand new pass 1")).res.status).toBe(200);
    await mailTo(email, /password was changed/, before);
  });

  it("lists this user's sessions and revokes one", async () => {
    const email = uniqEmail("sessions");
    const mine = await signUp(email);
    const other = (await signIn(email)).cookie;
    const stranger = await signUp(uniqEmail("stranger"));
    const list = await get("/list-sessions", mine);
    expect(list.status).toBe(200);
    const sessions = (await list.json()) as { token: string; userAgent: string | null }[];
    expect(sessions).toHaveLength(2);
    const otherToken = decodeURIComponent(other.split("=")[1] ?? "").split(".")[0];
    expect(sessions.map((s) => s.token)).toContain(otherToken);

    // Someone else's token is ignored.
    const strangerToken = decodeURIComponent(stranger.split("=")[1] ?? "").split(".")[0];
    await post("/revoke-session", { token: strangerToken }, mine);
    expect(await sessionUser(stranger)).not.toBeNull();

    const res = await post("/revoke-session", { token: otherToken }, mine);
    expect(res.status).toBe(200);
    expect(await sessionUser(other)).toBeNull();
    expect(await sessionUser(mine)).not.toBeNull();
  });
});

describe("two-step sign-in (TOTP)", () => {
  const email = uniqEmail("mfa");
  let cookie: string;
  let uri: string;
  let backupCodes: string[];

  beforeAll(async () => {
    cookie = await signUp(email);
  });

  it("an unverified email can't turn it on (a squatter can't lock the real owner out)", async () => {
    const res = await post("/two-factor/enable", { password: PASSWORD }, cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(
      await db
        .select()
        .from(twoFactors)
        .innerJoin(users, eq(users.id, twoFactors.userId))
        .where(eq(users.email, email)),
    ).toEqual([]);
    await db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  });

  it("enabling needs the password and returns an InvAI TOTP URI and 10 backup codes", async () => {
    const wrong = await post("/two-factor/enable", { password: "nope nope nope" }, cookie);
    expect(wrong.status).toBe(400);
    const res = await post("/two-factor/enable", { password: PASSWORD }, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totpURI: string; backupCodes: string[] };
    uri = body.totpURI;
    backupCodes = body.backupCodes;
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.searchParams.get("issuer")).toBe("InvAI");
    expect(decodeURIComponent(parsed.pathname)).toContain(email);
    expect(backupCodes).toHaveLength(10);
    // Not on until the first code is confirmed.
    expect(await sessionUser(cookie)).toMatchObject({ twoFactorEnabled: false });
    const [row] = await db
      .select()
      .from(twoFactors)
      .innerJoin(users, eq(users.id, twoFactors.userId))
      .where(eq(users.email, email));
    expect(row?.two_factors.verified).toBe(false);
    // Stored encrypted, never the plain secret or codes.
    expect(row?.two_factors.secret).not.toContain(parsed.searchParams.get("secret") ?? "");
    expect(row?.two_factors.backupCodes).not.toContain(backupCodes[0] ?? "");
  });

  it("the first authenticator code turns it on and sends a notice", async () => {
    const bad = await post("/two-factor/verify-totp", { code: "000000" }, cookie);
    expect(bad.status).toBe(401);
    const before = mail.sent.length;
    const res = await post("/two-factor/verify-totp", { code: totp(uri) }, cookie);
    expect(res.status).toBe(200);
    cookie = cookieOf(res);
    expect(await sessionUser(cookie)).toMatchObject({ twoFactorEnabled: true });
    await mailTo(email, /Two-step sign-in is on/, before);
  });

  it("sign-in returns twoFactorRedirect with no session until the code is given", async () => {
    const { res, body, cookie: pending } = await signIn(email);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    expect(pending).not.toContain("session_token");
    expect(await sessionUser(pending)).toBeNull();

    const wrong = await post("/two-factor/verify-totp", { code: "123456" }, pending);
    expect(wrong.status).toBe(401);
    const ok = await post("/two-factor/verify-totp", { code: totp(uri) }, pending);
    expect(ok.status).toBe(200);
    const session = cookieOf(ok);
    expect(await sessionUser(session)).toMatchObject({ email });
    // The pending challenge is spent.
    const replay = await post("/two-factor/verify-totp", { code: totp(uri) }, pending);
    expect(replay.status).toBe(401);
  });

  it("a code without a pending sign-in or a session gets nothing", async () => {
    const res = await post("/two-factor/verify-totp", { code: totp(uri) });
    expect(res.status).toBe(401);
    expect(cookieOf(res)).not.toContain("session_token");
  });

  it("a backup code signs in once", async () => {
    const code = backupCodes[0] as string;
    const first = await signIn(email);
    const ok = await post("/two-factor/verify-backup-code", { code }, first.cookie);
    expect(ok.status).toBe(200);
    expect(await sessionUser(cookieOf(ok))).toMatchObject({ email });
    const second = await signIn(email);
    const reuse = await post("/two-factor/verify-backup-code", { code }, second.cookie);
    expect(reuse.status).toBe(401);
  });

  it("turning it off needs the password and sends a notice", async () => {
    const wrong = await post("/two-factor/disable", { password: "nope nope nope" }, cookie);
    expect(wrong.status).toBe(400);
    const before = mail.sent.length;
    const res = await post("/two-factor/disable", { password: PASSWORD }, cookie);
    expect(res.status).toBe(200);
    await mailTo(email, /Two-step sign-in is off/, before);
    const { body } = await signIn(email);
    expect(body).not.toHaveProperty("twoFactorRedirect");
    expect(body).toMatchObject({ user: { email } });
  });
});

describe("auth rate limits", () => {
  // Rate limits are off in tests (sign-ups would trip them); this instance turns them on.
  const limited = betterAuth({
    ...authOptions,
    rateLimit: { ...authOptions.rateLimit, enabled: true },
  });
  const hit = (path: string, body: unknown, ip: string) =>
    limited.handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: env.WEB_ORIGIN,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify(body),
      }),
    );

  it("password reset requests: 5 per 15 minutes per IP", async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await hit("/request-password-reset", { email: uniqEmail("rl") }, "203.0.113.7")).status,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    // Another IP is unaffected.
    expect(
      (await hit("/request-password-reset", { email: uniqEmail("rl") }, "203.0.113.8")).status,
    ).toBe(200);
  });

  it("reset attempts, resends and password changes are limited too", async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await hit(
            "/reset-password",
            { token: "nope", newPassword: "whatever 123" },
            "203.0.113.9",
          )
        ).status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(authOptions.rateLimit.customRules).toMatchObject({
      "/send-verification-email": { window: 900, max: 5 },
      "/change-password": { window: 900, max: 10 },
    });
  });
});
