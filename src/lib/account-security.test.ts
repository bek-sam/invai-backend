import { createHmac } from "node:crypto";
import { call } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

/*
 * Amazon DPP account controls (T-28-2, ADR 0025) through the real HTTP surface: per-email sign-in
 * lockout, password history on change and reset, and required two-step sign-in for owners and
 * admins (the oRPC guard, me.get's `mfa`, the disable refusal, grace restarts). Mail is captured.
 */

type Sent = { to: string; subject: string; text: string };
const mail = vi.hoisted(() => ({ sent: [] as Sent[] }));
vi.mock("../integrations/vendors/mailer", async (orig) => ({
  ...(await orig<typeof import("../integrations/vendors/mailer")>()),
  sendMail: vi.fn(async (m: Sent) => {
    mail.sent.push(m);
    return { messageId: `<${mail.sent.length}@test>` };
  }),
}));

const { app } = await import("../api/app");
const { buildContext } = await import("../api/context");
const { router } = await import("../api/router");
const { db, withSystem, withTenant } = await import("../db/client");
const { companies, members, passwordHistory, signInFailures, users } = await import("../db/schema");
const { env } = await import("../env");
const { emailKey, giveBack, reserveAttempt } = await import("./account-lockout");
const { isMfaRequired, mfaBlocks, mfaState } = await import("./mfa");
const { PASSWORD_HISTORY_SIZE, recordCurrentPassword } = await import("./password-history");
const { changeRole } = await import("../modules/tenancy/service");
const { issueStationToken, pinLogin, setPin } = await import("../modules/tenancy/floor-auth");
const { createCompany, createLocation, createStation, createUser, tenantContext } = await import(
  "../test/fixtures"
);

const PASSWORD = "correct horse 1";
const DAY = 24 * 60 * 60 * 1000;

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
const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .filter((c) => !/max-age=0/i.test(c))
    .map((c) => c.split(";")[0])
    .join("; ");

let n = 0;
const uniqEmail = (p: string) => `${p}-${Date.now()}-${n++}@test.local`;

async function signUp(email: string) {
  const res = await post("/sign-up/email", { email, password: PASSWORD, name: "Sec Test" });
  expect(res.status).toBe(200);
  return cookieOf(res);
}
async function signIn(email: string, password = PASSWORD) {
  const res = await post("/sign-in/email", { email, password });
  return { res, body: (await res.json()) as Record<string, unknown>, cookie: cookieOf(res) };
}
async function userId(email: string) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!u) throw new Error(`no user ${email}`);
  return u.id;
}
const lockMails = (to: string) =>
  mail.sent.filter((m) => m.to === to && /locked|bloqueamos/i.test(m.subject));
async function wrong(email: string, times: number) {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++)
    statuses.push((await signIn(email, "wrong password 9")).res.status);
  return statuses;
}

/** RFC 6238 TOTP from an otpauth:// URI, like an authenticator app. */
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
  return ((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  if (!node) throw new Error(`no procedure ${path}`);
  return node as AnyProcedure;
}
/** Call a procedure the way the HTTP handler does: context built from the request headers. */
async function rpc(path: string, input: unknown, headers: Record<string, string>) {
  const context = await buildContext(new Request("http://x/api/v1", { headers }));
  try {
    const out = await call(procedureAt(path), input as never, {
      context,
      path: path.split("."),
    });
    return { code: "OK", out: out as Record<string, unknown>, data: undefined };
  } catch (err) {
    const e = err as { code?: string; data?: unknown };
    return { code: e.code ?? String(err), out: undefined, data: e.data };
  }
}

describe("sign-in lockout (B-185)", () => {
  it("10 wrong passwords lock the email for 30 minutes: even the right password gets 423, no session", async () => {
    const email = uniqEmail("lock");
    await signUp(email);
    expect(await wrong(email, 10)).toEqual(Array(10).fill(401));
    const { res, body, cookie } = await signIn(email);
    expect(res.status).toBe(423);
    expect(body).toMatchObject({ code: "ACCOUNT_LOCKED" });
    expect(body.retryAfterSec).toBeGreaterThan(29 * 60);
    expect(body.retryAfterSec).toBeLessThanOrEqual(30 * 60);
    expect(res.headers.get("retry-after")).toBe(String(body.retryAfterSec));
    expect(cookie).toBe("");
    // The table keeps an HMAC, never the address.
    const rows = await db.select().from(signInFailures);
    expect(JSON.stringify(rows)).not.toContain(email);
    // Same email, other case: same lock.
    expect((await signIn(email.toUpperCase())).res.status).toBe(423);
  });

  it("an unknown email locks exactly the same way (no account-exists signal)", async () => {
    const email = uniqEmail("ghost");
    expect(await wrong(email, 10)).toEqual(Array(10).fill(401));
    const { res, body } = await signIn(email);
    expect(res.status).toBe(423);
    expect(body).toMatchObject({ code: "ACCOUNT_LOCKED" });
    expect(lockMails(email)).toHaveLength(0);
  });

  it("a right password clears the streak; the lock ends by itself after 30 minutes", async () => {
    const email = uniqEmail("streak");
    await signUp(email);
    await wrong(email, 9);
    expect((await signIn(email)).res.status).toBe(200);
    await wrong(email, 9);
    expect((await signIn(email)).res.status).toBe(200);

    await wrong(email, 10);
    expect((await signIn(email)).res.status).toBe(423);
    await db
      .update(signInFailures)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(signInFailures.emailHmac, emailKey(email)));
    expect((await signIn(email)).res.status).toBe(200);
    const left = await db
      .select()
      .from(signInFailures)
      .where(eq(signInFailures.emailHmac, emailKey(email)));
    expect(left).toHaveLength(0);
  });

  it("sends one lock email (en/es) with the time and the reset way out; a reset unlocks at once", async () => {
    const email = uniqEmail("lockmail");
    await signUp(email);
    await db.update(users).set({ locale: "es" }).where(eq(users.email, email));
    await wrong(email, 10);
    await vi.waitFor(() => expect(lockMails(email)).toHaveLength(1), { timeout: 5_000 });
    const m = lockMails(email)[0] as Sent;
    expect(m.subject).toContain("30 minutos");
    expect(m.text).toContain("/forgot-password");
    // More attempts while locked: no second email.
    await wrong(email, 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(lockMails(email)).toHaveLength(1);

    const before = mail.sent.length;
    await post("/request-password-reset", { email });
    await vi.waitFor(() => expect(mail.sent.length).toBeGreaterThan(before), { timeout: 5_000 });
    const reset = mail.sent.slice(before).find((s) => s.to === email) as Sent;
    const token = decodeURIComponent(reset.text.match(/reset-password\?token=([^\s]+)/)?.[1] ?? "");
    expect((await post("/reset-password", { token, newPassword: "fresh horse 77" })).status).toBe(
      200,
    );
    expect((await signIn(email, "fresh horse 77")).res.status).toBe(200);
  });

  it("20 parallel wrong passwords lock once and send one email", async () => {
    const email = uniqEmail("burst");
    await signUp(email);
    const statuses = await Promise.all(
      Array.from({ length: 20 }, () => signIn(email, "wrong password 9").then((r) => r.res.status)),
    );
    expect(statuses.every((s) => s === 401 || s === 423)).toBe(true);
    await vi.waitFor(() => expect(lockMails(email)).toHaveLength(1), { timeout: 5_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(lockMails(email)).toHaveLength(1);
    expect((await signIn(email)).res.status).toBe(423);
  });

  it("counting is atomic: exactly one of N concurrent attempts crosses, only threshold are allowed", async () => {
    const email = uniqEmail("atomic");
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveAttempt(email)));
    expect(results.filter((r) => r.crossed)).toHaveLength(1);
    expect(results.filter((r) => r.allowed)).toHaveLength(env.ACCOUNT_LOCK_THRESHOLD);
    expect(Math.max(...results.map((r) => r.failures))).toBe(20);
  });

  it("S-57: a burst of 40 tests at most 10 passwords; the right one inside a locked burst gets no session", async () => {
    const email = uniqEmail("burst40");
    await signUp(email);
    const wrongs = Array.from({ length: 39 }, () =>
      signIn(email, "wrong password 9").then((r) => r.res.status),
    );
    // The right password, sent once the 10 allowed attempts are already counted.
    await vi.waitFor(async () => {
      const [row] = await db
        .select({ failures: signInFailures.failures })
        .from(signInFailures)
        .where(eq(signInFailures.emailHmac, emailKey(email)));
      expect(row?.failures ?? 0).toBeGreaterThanOrEqual(env.ACCOUNT_LOCK_THRESHOLD);
    });
    const right = await signIn(email);
    const statuses = await Promise.all(wrongs);
    expect(statuses.filter((s) => s === 401)).toHaveLength(env.ACCOUNT_LOCK_THRESHOLD);
    expect(statuses.filter((s) => s === 423)).toHaveLength(39 - env.ACCOUNT_LOCK_THRESHOLD);
    expect(right.res.status).toBe(423);
    expect(right.cookie).toBe("");
    await vi.waitFor(() => expect(lockMails(email)).toHaveLength(1), { timeout: 5_000 });
  });

  it("an attempt that tested no password is given back", async () => {
    const email = uniqEmail("giveback");
    for (let i = 0; i < 10; i++) await reserveAttempt(email);
    await giveBack(email);
    const [row] = await db
      .select()
      .from(signInFailures)
      .where(eq(signInFailures.emailHmac, emailKey(email)));
    expect(row?.failures).toBe(9);
    expect(row?.lockedUntil).toBeNull();
    expect((await reserveAttempt(email)).allowed).toBe(true);
  });
});

describe("password history (B-186)", () => {
  it("refuses the current password and the previous ones; nothing changes on a refusal", async () => {
    const email = uniqEmail("hist");
    const cookie = await signUp(email);
    const id = await userId(email);
    expect(
      await db.select().from(passwordHistory).where(eq(passwordHistory.userId, id)),
    ).toHaveLength(1);

    const same = await post(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: PASSWORD },
      cookie,
    );
    expect(same.status).toBe(400);
    expect(await same.json()).toMatchObject({ code: "PASSWORD_REUSED" });

    const ok = await post(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: "second horse 2" },
      cookie,
    );
    expect(ok.status).toBe(200);
    const fresh = cookieOf(ok);
    const back = await post(
      "/change-password",
      { currentPassword: "second horse 2", newPassword: PASSWORD },
      fresh,
    );
    expect(back.status).toBe(400);
    expect(await back.json()).toMatchObject({ code: "PASSWORD_REUSED" });
    expect((await signIn(email, "second horse 2")).res.status).toBe(200);
    expect((await signIn(email, PASSWORD)).res.status).toBe(401);
  });

  it("a wrong current password is INVALID_PASSWORD, never a hint about old passwords", async () => {
    const email = uniqEmail("probe");
    const cookie = await signUp(email);
    const res = await post(
      "/change-password",
      { currentPassword: "not my password", newPassword: PASSWORD },
      cookie,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_PASSWORD" });
  });

  it("a reset to an old password is refused and the link still works for a new one", async () => {
    const email = uniqEmail("histreset");
    await signUp(email);
    const before = mail.sent.length;
    await post("/request-password-reset", { email });
    await vi.waitFor(() => expect(mail.sent.length).toBeGreaterThan(before), { timeout: 5_000 });
    const reset = mail.sent.slice(before).find((s) => s.to === email) as Sent;
    const token = decodeURIComponent(reset.text.match(/reset-password\?token=([^\s]+)/)?.[1] ?? "");
    const reused = await post("/reset-password", { token, newPassword: PASSWORD });
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ code: "PASSWORD_REUSED" });
    expect((await post("/reset-password", { token, newPassword: "reset horse 3" })).status).toBe(
      200,
    );
    const rows = await db
      .select()
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, await userId(email)));
    expect(rows).toHaveLength(2);
  });

  it(`keeps at most ${PASSWORD_HISTORY_SIZE} hashes per user, deleted with the user`, async () => {
    const email = uniqEmail("cap");
    await signUp(email);
    const id = await userId(email);
    for (let i = 0; i < 12; i++) {
      await db.execute(
        sql`update accounts set password = ${`fake-hash-${i}`} where user_id = ${id} and provider_id = 'credential'`,
      );
      await recordCurrentPassword(id);
      await recordCurrentPassword(id); // the same hash twice is one entry
    }
    const rows = await db.select().from(passwordHistory).where(eq(passwordHistory.userId, id));
    expect(rows).toHaveLength(PASSWORD_HISTORY_SIZE);
    expect(rows.map((r) => r.hash)).toContain("fake-hash-11");
    expect(rows.map((r) => r.hash)).not.toContain("fake-hash-1");
    await db.delete(users).where(eq(users.id, id));
    expect(
      await db.select().from(passwordHistory).where(eq(passwordHistory.userId, id)),
    ).toHaveLength(0);
  });
});

describe("required two-step sign-in (B-188)", () => {
  const shop = { type: "shop" as const, demo: false };
  it("required = owner/admin in a real org; vendors, sample workspaces and staff don't count", () => {
    expect(isMfaRequired([{ ...shop, role: "owner" }])).toBe(true);
    expect(isMfaRequired([{ ...shop, role: "admin" }])).toBe(true);
    expect(isMfaRequired([{ ...shop, role: "office" }])).toBe(false);
    expect(isMfaRequired([{ type: "shop", demo: true, role: "owner" }])).toBe(false);
    expect(isMfaRequired([{ type: "vendor", demo: false, role: "vendor" }])).toBe(false);
    expect(
      isMfaRequired([
        { ...shop, role: "office" },
        { ...shop, role: "admin" },
      ]),
    ).toBe(true);
    const start = new Date("2026-10-01T00:00:00Z");
    const state = mfaState(
      { memberships: [{ ...shop, role: "owner" }], twoFactorEnabled: false, graceStartsAt: start },
      7,
    );
    expect(state.deadline?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(mfaBlocks(state, new Date("2026-10-07T23:59:59Z"))).toBe(false);
    expect(mfaBlocks(state, new Date("2026-10-08T00:00:00Z"))).toBe(true);
    expect(mfaBlocks({ ...state, enabled: true }, new Date("2027-01-01"))).toBe(false);
    expect(mfaState({ memberships: [], twoFactorEnabled: false, graceStartsAt: start }, 7)).toEqual(
      { required: false, enabled: false, deadline: null },
    );
  });

  it("an owner past the deadline gets MFA_REQUIRED everywhere except me.get/switchOrg, until two-step is on", async () => {
    const email = uniqEmail("owner");
    let cookie = await signUp(email);
    const id = await userId(email);
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, id));
    const created = await post(
      "/organization/create",
      { name: "MFA Shop", slug: `mfa-${Date.now()}-${n++}` },
      cookie,
    );
    expect(created.status).toBe(200);
    const orgId = ((await created.json()) as { id: string }).id;

    // Inside the grace period: nothing is blocked, me.get shows the deadline.
    const me = await rpc("me.get", {}, { cookie });
    expect(me.code).toBe("OK");
    const mfa = me.out?.mfa as { required: boolean; enabled: boolean; deadline: string };
    expect(mfa).toMatchObject({ required: true, enabled: false });
    expect(new Date(mfa.deadline).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect((await rpc("orders.list", {}, { cookie })).code).toBe("OK");

    // Past the deadline.
    await db
      .update(users)
      .set({ mfaGraceStartsAt: new Date(Date.now() - 8 * DAY) })
      .where(eq(users.id, id));
    const blocked = await rpc("orders.list", {}, { cookie });
    expect(blocked.code).toBe("MFA_REQUIRED");
    expect((blocked.data as { deadline: string }).deadline).toMatch(/^\d{4}-/);
    expect((await rpc("me.get", {}, { cookie })).code).toBe("OK");
    expect((await rpc("me.switchOrg", { orgId }, { cookie })).code).toBe("OK");

    // Turn it on: the same call works; turning it off is refused while required.
    const enable = await post("/two-factor/enable", { password: PASSWORD }, cookie);
    expect(enable.status).toBe(200);
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const verified = await post("/two-factor/verify-totp", { code: totp(totpURI) }, cookie);
    expect(verified.status).toBe(200);
    cookie = cookieOf(verified);
    expect((await rpc("orders.list", {}, { cookie })).code).toBe("OK");
    const off = await post("/two-factor/disable", { password: PASSWORD }, cookie);
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ code: "MFA_DISABLE_NOT_ALLOWED" });
  });

  it("a user who is not required sees required=false and is never blocked", async () => {
    const company = await createCompany();
    const office = await createUser(company.id, "office");
    await db
      .update(users)
      .set({ mfaGraceStartsAt: new Date(Date.now() - 90 * DAY) })
      .where(eq(users.id, office.id));
    const { mfaBlocks: blocks, loadMfaState } = await import("./mfa");
    const state = await loadMfaState(office.id);
    expect(state).toEqual({ required: false, enabled: false, deadline: null });
    expect(blocks(state ?? undefined)).toBe(false);
  });

  it("an office user promoted to admin long after their own grace gets a fresh grace period", async () => {
    const company = await createCompany();
    const owner = await createUser(company.id, "owner");
    const office = await createUser(company.id, "office");
    const longAgo = new Date(Date.now() - 60 * DAY);
    await db.update(users).set({ mfaGraceStartsAt: longAgo }).where(eq(users.id, office.id));
    await withTenant(company.id, (tx) =>
      changeRole(tx, tenantContext(company.id, owner.id, "owner"), {
        userId: office.id,
        role: "admin",
      }),
    );
    const { loadMfaState } = await import("./mfa");
    const state = await loadMfaState(office.id);
    expect(state?.required).toBe(true);
    expect(state?.deadline?.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(mfaBlocks(state ?? undefined)).toBe(false);

    // Already required: a second promotion keeps the deadline.
    const before = state?.deadline?.getTime();
    await withTenant(company.id, (tx) =>
      changeRole(tx, tenantContext(company.id, owner.id, "owner"), {
        userId: office.id,
        role: "owner",
      }),
    );
    expect((await loadMfaState(office.id))?.deadline?.getTime()).toBe(before);
  });

  it("an owner of a sample workspace only is never required", async () => {
    const [demo] = await withSystem((tx) =>
      tx
        .insert(companies)
        .values({ name: "Sample", slug: `sample-${Date.now()}-${n++}`, type: "shop", demo: true })
        .returning(),
    );
    const real = await createCompany();
    const designer = await createUser(real.id, "designer");
    await withSystem((tx) =>
      tx
        .insert(members)
        .values({ organizationId: demo?.id as string, userId: designer.id, role: "owner" }),
    );
    await db
      .update(users)
      .set({ mfaGraceStartsAt: new Date(Date.now() - 90 * DAY) })
      .where(eq(users.id, designer.id));
    const { loadMfaState } = await import("./mfa");
    expect((await loadMfaState(designer.id))?.required).toBe(false);
  });

  it("floor PIN sessions are never asked for two-step sign-in", async () => {
    const company = await createCompany();
    const owner = await createUser(company.id, "owner");
    await db
      .update(users)
      .set({ mfaGraceStartsAt: new Date(Date.now() - 90 * DAY) })
      .where(eq(users.id, owner.id));
    const location = await createLocation(company.id);
    const station = await createStation(company.id, location.id);
    const stationToken = await withTenant(company.id, async (tx) => {
      await setPin(tx, {
        companyId: company.id,
        userId: owner.id,
        pin: "4321",
        actorUserId: owner.id,
      });
      return (
        await issueStationToken(tx, {
          companyId: company.id,
          stationId: station.id,
          userId: owner.id,
        })
      ).token;
    });
    const floor = await pinLogin({ stationToken, pin: "4321", ip: null });
    const { CONTRACT_VERSION } = await import("@invai/contracts");
    const res = await rpc(
      "me.get",
      {},
      { authorization: `Bearer ${floor.token}`, "x-contract-version": CONTRACT_VERSION },
    );
    expect(res.code).toBe("OK");
    expect(res.out).not.toHaveProperty("mfa");
  });
});
