import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../../api/app";
import { buildContext } from "../../api/context";
import { db, withSystem, withTenant } from "../../db/client";
import { companies, invitations, members, users } from "../../db/schema";
import { env } from "../../env";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";

type Sent = { to: string; subject: string; text: string; html?: string };
type AtSend = { busy: number; committed: boolean };
const mail = vi.hoisted(() => ({
  sent: [] as Sent[],
  fail: false,
  delayMs: 0,
  atSend: [] as AtSend[],
}));
vi.mock("../../integrations/vendors/mailer", async (orig) => ({
  ...(await orig<typeof import("../../integrations/vendors/mailer")>()),
  sendMail: vi.fn(async (m: Sent) => {
    // What the database looks like while the email goes out: connections checked out of either
    // pool (an open transaction holds one), and whether the linked invitation is already
    // committed (visible from a fresh connection).
    const { appPool, systemPool, db: freshDb } = await import("../../db/client");
    const { invitations: inv } = await import("../../db/schema");
    const { eq: eqOp } = await import("drizzle-orm");
    const busy =
      appPool.totalCount - appPool.idleCount + systemPool.totalCount - systemPool.idleCount;
    const id = m.text.match(/\/accept-invite\/([0-9a-f-]{36})/)?.[1];
    const committed = id
      ? (await freshDb.select({ id: inv.id }).from(inv).where(eqOp(inv.id, id))).length === 1
      : false;
    mail.atSend.push({ busy, committed });
    if (mail.delayMs) await new Promise((r) => setTimeout(r, mail.delayMs));
    if (mail.fail) throw new Error("smtp down");
    mail.sent.push(m);
    return { messageId: `<${mail.sent.length}@test>` };
  }),
}));

const svc = await import("./service");
const { inviteEmail, invitePreview, sendInviteEmail } = await import("./invites");

const json = (body: unknown, cookie?: string) => ({
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
    .map((c) => c.split(";")[0])
    .join("; ");

async function signUp(email: string) {
  const res = await app.request(
    "/api/auth/sign-up/email",
    json({ email, password: "correct horse 1", name: "New Person" }),
  );
  expect(res.status).toBe(200);
  return cookieOf(res);
}

const accept = (invitationId: string, cookie: string) =>
  app.request("/api/auth/organization/accept-invitation", json({ invitationId }, cookie));

const linkId = (m: Sent) => {
  const match = m.text.match(/\/accept-invite\/([0-9a-f-]{36})/);
  if (!match?.[1]) throw new Error(`no invite link in: ${m.text}`);
  return match[1];
};

describe("team invites", () => {
  let companyId: string;
  let owner: ReturnType<typeof tenantContext>;
  const uniqEmail = (p: string) =>
    `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const invite = (email: string, role: "office" | "presser" = "office") =>
    svc.inviteTeammate(owner, { email, name: "Rosa", role });

  beforeAll(async () => {
    companyId = (await createCompany({ name: "Desert Test" })).id;
    owner = tenantContext(companyId, (await createUser(companyId, "owner")).id, "owner");
    // These tests send many invites; the trial's 3-seat limit is tested in billing (T-2-1).
    await withSystem((tx) =>
      tx.update(companies).set({ plan: "scale" }).where(eq(companies.id, companyId)),
    );
  });

  it("creates a Better Auth invitation and emails an /accept-invite link, with no user row", async () => {
    const email = uniqEmail("rosa");
    const user = await invite(email.toUpperCase());
    expect(user).toMatchObject({ email, status: "invited", role: "office", name: "Rosa" });
    const [row] = await db.select().from(invitations).where(eq(invitations.id, user.id));
    expect(row).toMatchObject({
      organizationId: companyId,
      email,
      role: "office",
      status: "pending",
    });
    expect(row?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0);
    const m = mail.sent.at(-1);
    expect(m?.to).toBe(email);
    expect(m?.subject).toContain("Desert Test");
    expect(m?.text).toContain(`${env.WEB_ORIGIN}/accept-invite/${user.id}`);
    expect(m?.html).toContain(`/accept-invite/${user.id}`);
    // The team list shows it as invited until it is accepted.
    const team = await withTenant(companyId, (tx) =>
      svc.listTeam(tx, owner, { limit: 50, includeDeactivated: false }),
    );
    expect(team.items.find((u) => u.id === user.id)?.status).toBe("invited");
  });

  it("sends the email after the invitation is committed, with no transaction open", async () => {
    mail.atSend.length = 0;
    const inv = await invite(uniqEmail("notx"));
    expect(mail.atSend).toEqual([{ busy: 0, committed: true }]);
    expect(mail.sent.at(-1)?.text).toContain(inv.id);
  });

  it("a failed resend leaves the earlier invite and its link exactly as they were", async () => {
    const email = uniqEmail("retry");
    const first = await invite(email);
    mail.fail = true;
    mail.atSend.length = 0;
    try {
      await expect(invite(email, "presser")).rejects.toMatchObject({ code: "UPSTREAM_FAILED" });
    } finally {
      mail.fail = false;
    }
    // The failed invitation existed (committed) when the send was tried, and is gone now.
    expect(mail.atSend).toEqual([{ busy: 0, committed: true }]);
    const rows = await db.select().from(invitations).where(eq(invitations.email, email));
    expect(rows.map((r) => [r.id, r.status])).toEqual([[first.id, "pending"]]);
    expect(await invitePreview(first.id)).toMatchObject({ status: "pending" });
  });

  it("a mail server that hangs counts as not sent", async () => {
    mail.delayMs = 500;
    try {
      await expect(
        sendInviteEmail(
          "slow@test.local",
          {
            companyId: crypto.randomUUID(),
            locale: "en",
            kind: "staff",
            companyName: "Desert Test",
            inviterName: null,
            role: "office",
            link: "http://web/accept-invite/x",
            expiresAt: new Date(),
          },
          50,
        ),
      ).rejects.toMatchObject({ code: "UPSTREAM_FAILED" });
    } finally {
      mail.delayMs = 0;
    }
  });

  it("a failed email fails the invite and saves nothing", async () => {
    const email = uniqEmail("nomail");
    mail.fail = true;
    try {
      await expect(invite(email)).rejects.toMatchObject({ code: "UPSTREAM_FAILED" });
    } finally {
      mail.fail = false;
    }
    expect(await db.select().from(invitations).where(eq(invitations.email, email))).toHaveLength(0);
  });

  it("re-inviting resends the one pending invite (new role, new expiry); members can't be invited again", async () => {
    const email = uniqEmail("again");
    const first = await invite(email);
    await db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(invitations.id, first.id));
    const sentBefore = mail.sent.length;
    const second = await invite(email, "presser");
    expect(second).toMatchObject({ id: first.id, role: "presser", status: "invited" });
    expect(mail.sent.length).toBe(sentBefore + 1);
    expect(linkId(mail.sent.at(-1) as Sent)).toBe(first.id);
    const rows = await db.select().from(invitations).where(eq(invitations.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", role: "presser" });
    expect(rows[0]?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const member = await createUser(companyId, "office", { email: uniqEmail("member") });
    await expect(invite(member.email)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("the database allows one pending invite per company and email", async () => {
    const email = uniqEmail("dup");
    await invite(email);
    await expect(
      db.insert(invitations).values({
        organizationId: companyId,
        email,
        role: "office",
        status: "pending",
        inviterId: owner.userId as string,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    // Canceled and accepted rows don't count.
    await db.insert(invitations).values({
      organizationId: companyId,
      email,
      role: "office",
      status: "canceled",
      inviterId: owner.userId as string,
    });
  });

  it("team.resend sends the invite again; team.revoke cancels it; both refuse non-invites", async () => {
    const email = uniqEmail("resend");
    const inv = await invite(email);
    await db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(invitations.id, inv.id));
    const resent = await svc.resendInvite(owner, inv.id);
    expect(resent).toMatchObject({ id: inv.id, status: "invited", role: "office" });
    expect(mail.sent.at(-1)?.to).toBe(email);
    const [row] = await db.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(row?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    expect(await withTenant(companyId, (tx) => svc.revokeInvite(tx, owner, inv.id))).toEqual({
      ok: true,
    });
    expect(await invitePreview(inv.id)).toMatchObject({ status: "not_found" });
    await expect(svc.resendInvite(owner, inv.id)).rejects.toMatchObject({ code: "NOT_INVITED" });
    await expect(
      withTenant(companyId, (tx) => svc.revokeInvite(tx, owner, inv.id)),
    ).rejects.toMatchObject({ code: "NOT_INVITED" });
    // A member is not an invitation.
    await expect(svc.resendInvite(owner, owner.userId as string)).rejects.toMatchObject({
      code: "NOT_INVITED",
    });
    // Revoking frees the email for a brand-new invite.
    const again = await invite(email);
    expect(again.id).not.toBe(inv.id);
  });

  it("a revoke racing an accept never cancels the accepted invite", async () => {
    type RevokeTx = Parameters<typeof svc.revokeInvite>[0];
    const cancels: ((tx: RevokeTx, id: string) => Promise<unknown>)[] = [
      (tx, id) => svc.revokeInvite(tx, owner, id),
      (tx, id) => svc.setMemberStatus(tx, owner, id, "deactivated"),
    ];
    for (const cancel of cancels) {
      const inv = await invite(uniqEmail("race"));
      // The accept commits on another connection after the revoke read the pending row and
      // before its UPDATE runs.
      const acceptFirst = (tx: RevokeTx) =>
        new Proxy(tx, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop !== "update") return typeof value === "function" ? value.bind(target) : value;
            return (table: typeof invitations) => {
              const builder = target.update(table);
              return {
                set: (values: Partial<typeof invitations.$inferInsert>) => {
                  const setB = builder.set(values);
                  return {
                    where: (cond: Parameters<typeof setB.where>[0]) => {
                      const whereB = setB.where(cond);
                      return {
                        returning: (cols: Parameters<typeof whereB.returning>[0]) =>
                          db
                            .update(invitations)
                            .set({ status: "accepted" })
                            .where(eq(invitations.id, inv.id))
                            .then(() => whereB.returning(cols)),
                      };
                    },
                  };
                },
              };
            };
          },
        }) as RevokeTx;
      await expect(
        withTenant(companyId, (tx) => cancel(acceptFirst(tx), inv.id)),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const [row] = await db.select().from(invitations).where(eq(invitations.id, inv.id));
      expect(row?.status).toBe("accepted");
    }
  });

  it("an admin can't resend or revoke an owner invite", async () => {
    const inv = await invite(uniqEmail("own"), "owner" as "office");
    const admin = tenantContext(companyId, (await createUser(companyId, "admin")).id, "admin");
    await expect(svc.resendInvite(admin, inv.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      withTenant(companyId, (tx) => svc.revokeInvite(tx, admin, inv.id)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the invitee signs up with the invited email and becomes an active member with that role", async () => {
    const email = uniqEmail("newbie");
    const inv = await invite(email, "presser");
    const id = linkId(mail.sent.at(-1) as Sent);
    expect(id).toBe(inv.id);

    const preview = await app.request(`/api/auth/invite-preview?id=${id}`);
    expect(await preview.json()).toMatchObject({
      status: "pending",
      email,
      role: "presser",
      organizationName: "Desert Test",
      invitedBy: null,
      hasAccount: false,
    });

    // Someone signed in with another email can't take it.
    const stranger = await signUp(uniqEmail("stranger"));
    expect((await accept(id, stranger)).status).toBe(403);

    const cookie = await signUp(email);
    const res = await accept(id, cookie);
    expect(res.status).toBe(200);
    const [member] = await db
      .select({ role: members.role, status: members.status })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(users.email, email), eq(members.organizationId, companyId)));
    expect(member).toEqual({ role: "presser", status: "active" });

    // The API sees them as an active presser in this company.
    const ctx = await buildContext(
      new Request("http://localhost/rpc", { headers: { cookie, origin: env.WEB_ORIGIN } }),
    );
    expect(ctx).toMatchObject({ companyId, role: "presser", sessionKind: "user" });

    // Used links say so, and can't be accepted twice.
    expect(await invitePreview(id)).toEqual({ status: "used" });
    expect((await accept(id, cookie)).status).toBe(400);
  });

  it("an existing user just signs in and accepts", async () => {
    const email = uniqEmail("known");
    const cookie = await signUp(email); // has an account, no company yet
    const inv = await invite(email);
    expect(await invitePreview(inv.id)).toMatchObject({ status: "pending", hasAccount: true });
    expect((await accept(inv.id, cookie)).status).toBe(200);
    const [member] = await db
      .select({ status: members.status })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(users.email, email), eq(members.organizationId, companyId)));
    expect(member?.status).toBe("active");
  });

  it("expired, canceled and unknown links show their status only", async () => {
    const email = uniqEmail("late");
    const inv = await invite(email);
    await withSystem((tx) =>
      tx
        .update(invitations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(invitations.id, inv.id)),
    );
    expect(await invitePreview(inv.id)).toEqual({ status: "expired" });
    const cookie = await signUp(email);
    expect((await accept(inv.id, cookie)).status).toBe(400);

    const cancel = await invite(uniqEmail("cancel"));
    await withTenant(companyId, (tx) => svc.setMemberStatus(tx, owner, cancel.id, "deactivated"));
    expect(await invitePreview(cancel.id)).toEqual({ status: "not_found" });
    expect(await invitePreview("not-a-uuid")).toEqual({ status: "not_found" });
    expect(await invitePreview(crypto.randomUUID())).toEqual({ status: "not_found" });
  });

  it("changing a pending invite's role and setting its PIN behave", async () => {
    const inv = await invite(uniqEmail("role"));
    const changed = await withTenant(companyId, (tx) =>
      svc.changeRole(tx, owner, { userId: inv.id, role: "packer" }),
    );
    expect(changed).toMatchObject({ id: inv.id, role: "packer", status: "invited" });
    await expect(
      withTenant(companyId, (tx) => svc.setUserPin(tx, owner, { userId: inv.id, pin: "5555" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Another company can't touch it.
    const otherCo = (await createCompany()).id;
    const otherOwner = tenantContext(otherCo, (await createUser(otherCo, "owner")).id, "owner");
    await expect(
      withTenant(otherCo, (tx) =>
        svc.changeRole(tx, otherOwner, { userId: inv.id, role: "admin" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("invite email", () => {
  const base = {
    kind: "staff" as const,
    companyName: "Desert Bloom",
    inviterName: "Ana",
    role: "presser" as const,
    link: "http://web/accept-invite/x",
    expiresAt: new Date("2026-10-01T12:00:00Z"),
  };
  it("is English by default and Spanish for a Spanish-speaking company", () => {
    const en = inviteEmail({ ...base, locale: "en" });
    expect(en.subject).toBe("Ana invited you to Desert Bloom on InvAI");
    expect(en.text).toContain("as Presser");
    const es = inviteEmail({ ...base, locale: "es" });
    expect(es.subject).toBe("Ana te invitó a Desert Bloom en InvAI");
    expect(es.text).toContain("como Planchador");
    expect(es.html).toContain("Aceptar invitación");
    expect(inviteEmail({ ...base, locale: null }).subject).toBe(en.subject);
  });
  it("escapes names in the HTML", () => {
    const m = inviteEmail({ ...base, locale: "en", companyName: "<b>Evil</b>" });
    expect(m.html).not.toContain("<b>Evil</b>");
  });
});
