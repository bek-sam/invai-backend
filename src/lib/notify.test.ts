import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../db/client";
import { companies, emailSends, members, notificationPreferences } from "../db/schema";
import { env } from "../env";
import { clearSampleWorkspaceCache } from "../modules/tenancy/demo-flag";
import { createCompany, createUser } from "../test/fixtures";
import { verifyLinkToken } from "./links";
import {
  buildMessageId,
  emailFooter,
  getEmailPreference,
  getEmailSend,
  listEmailPreferencesTx,
  mailDomain,
  outcomeOf,
  postalAddress,
  type SendUserEmailInput,
  sendUserEmail,
  setEmailPreference,
  suppressEmail,
  undoUnsubscribe,
  unsubscribeHeaders,
} from "./notify";

const uniq = () => crypto.randomUUID().slice(0, 8);

async function shop(role: "owner" | "office" | "presser" = "office") {
  const company = await createCompany({ name: `Notify Tees ${uniq()}` });
  const user = await createUser(company.id, role);
  return { companyId: company.id, userId: user.id };
}

function mail(companyId: string, userId: string, over: Partial<SendUserEmailInput> = {}) {
  const key = uniq();
  return {
    companyId,
    userId,
    kind: "digest" as const,
    dedupeKey: `digest:${key}:${userId}`,
    messageId: buildMessageId(`digest.${key}.${userId}`),
    subject: `T-19-4 test ${key}`,
    text: "test",
    html: "<p>test</p>",
    unsubscribe: true,
    ...over,
  };
}

describe("email preferences (AC1 / spec AC23)", () => {
  it("defaults to off with no source; only settings can turn on; admin and link turn off", async () => {
    const { companyId, userId } = await shop();
    expect(await getEmailPreference(companyId, userId, "digest")).toEqual({
      kind: "digest",
      on: false,
      source: null,
      updatedAt: null,
    });
    await expect(
      setEmailPreference(companyId, userId, "digest", { on: true, source: "admin" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      setEmailPreference(companyId, userId, "digest", { on: true, source: "unsubscribe_link" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await getEmailPreference(companyId, userId, "digest")).on).toBe(false);

    const on = await setEmailPreference(companyId, userId, "digest", {
      on: true,
      source: "settings",
    });
    expect(on).toMatchObject({ on: true, source: "settings" });
    expect(on.updatedAt).not.toBeNull();

    const off = await setEmailPreference(companyId, userId, "digest", {
      on: false,
      source: "admin",
    });
    expect(off).toMatchObject({ on: false, source: "admin" });
    // Upsert: still one row.
    const rows = await withTenant(companyId, (tx) =>
      tx.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)),
    );
    expect(rows).toHaveLength(1);
    const list = await withTenant(companyId, (tx) => listEmailPreferencesTx(tx, companyId, userId));
    expect(list.map((p) => p.kind)).toEqual(["digest"]);
  });

  it("is isolated per company: shop B cannot see or change shop A's preference (RLS)", async () => {
    const a = await shop();
    const b = await shop();
    await setEmailPreference(a.companyId, a.userId, "digest", { on: true, source: "settings" });
    // B reading A's row by ids sees nothing (default off), and the raw table is empty for B.
    expect((await getEmailPreference(b.companyId, a.userId, "digest")).on).toBe(false);
    const seen = await withTenant(b.companyId, (tx) =>
      tx.select().from(notificationPreferences).where(eq(notificationPreferences.userId, a.userId)),
    );
    expect(seen).toEqual([]);
    // Writing A's company_id from inside B's transaction fails the RLS WITH CHECK.
    const crossWrite = await withTenant(b.companyId, (tx) =>
      tx.insert(notificationPreferences).values({
        companyId: a.companyId,
        userId: a.userId,
        kind: "digest",
        on: false,
        source: "admin",
      }),
    ).then(
      () => "inserted",
      (err: unknown) => String((err as { cause?: unknown }).cause ?? err),
    );
    expect(crossWrite).toMatch(/row-level security/);
    expect((await getEmailPreference(a.companyId, a.userId, "digest")).on).toBe(true);
  });

  it("undo restores an unsubscribe within 24 h only", async () => {
    const { companyId, userId } = await shop();
    expect(await undoUnsubscribe(companyId, userId, "digest")).toBe("not_unsubscribed");
    await setEmailPreference(companyId, userId, "digest", { on: true, source: "settings" });
    await setEmailPreference(companyId, userId, "digest", {
      on: false,
      source: "unsubscribe_link",
    });
    expect(await undoUnsubscribe(companyId, userId, "digest")).toBe("restored");
    expect(await getEmailPreference(companyId, userId, "digest")).toMatchObject({
      on: true,
      source: "settings",
    });
    await setEmailPreference(companyId, userId, "digest", {
      on: false,
      source: "unsubscribe_link",
    });
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(await undoUnsubscribe(companyId, userId, "digest", later)).toBe("expired");
    expect((await getEmailPreference(companyId, userId, "digest")).on).toBe(false);
  });
});

describe("sendUserEmail (AC2, AC3 / spec AC2, AC26)", () => {
  it("sends once for a dedupe key, records the row, and answers duplicate afterwards", async () => {
    const { companyId, userId } = await shop("owner");
    await setEmailPreference(companyId, userId, "digest", { on: true, source: "settings" });
    const input = mail(companyId, userId);
    const first = await sendUserEmail(input);
    expect(first).toEqual({ status: "sent", messageId: input.messageId });
    const second = await sendUserEmail(input);
    expect(second).toEqual({ status: "skipped", reason: "duplicate" });
    const row = await getEmailSend(companyId, input.dedupeKey);
    expect(row).toMatchObject({
      status: "sent",
      kind: "digest",
      userId,
      messageId: input.messageId,
      reason: null,
    });
    expect(row?.sentAt).toBeInstanceOf(Date);
    const all = await withTenant(companyId, (tx) =>
      tx.select().from(emailSends).where(eq(emailSends.dedupeKey, input.dedupeKey)),
    );
    expect(all).toHaveLength(1);
  });

  it("retakes a failed or stale pending row; a fresh pending row is a duplicate", async () => {
    const { companyId, userId } = await shop("owner");
    await setEmailPreference(companyId, userId, "digest", { on: true, source: "settings" });
    const failed = mail(companyId, userId);
    await withTenant(companyId, (tx) =>
      tx.insert(emailSends).values({
        companyId,
        userId,
        kind: "digest",
        dedupeKey: failed.dedupeKey,
        messageId: failed.messageId,
        status: "failed",
        reason: "smtp down",
      }),
    );
    expect((await sendUserEmail(failed)).status).toBe("sent");

    const fresh = mail(companyId, userId);
    await withTenant(companyId, (tx) =>
      tx.insert(emailSends).values({
        companyId,
        userId,
        kind: "digest",
        dedupeKey: fresh.dedupeKey,
        messageId: fresh.messageId,
        status: "pending",
      }),
    );
    expect(await sendUserEmail(fresh)).toEqual({ status: "skipped", reason: "duplicate" });

    const stale = mail(companyId, userId);
    await withTenant(companyId, (tx) =>
      tx.insert(emailSends).values({
        companyId,
        userId,
        kind: "digest",
        dedupeKey: stale.dedupeKey,
        messageId: stale.messageId,
        status: "pending",
        updatedAt: new Date(Date.now() - 11 * 60_000),
      }),
    );
    expect((await sendUserEmail(stale)).status).toBe("sent");
  });

  it("skips with the right reason: opted_out, unverified, placeholder, not_member, suppressed, sample_workspace", async () => {
    const { companyId, userId } = await shop("owner");
    expect(await sendUserEmail(mail(companyId, userId))).toEqual({
      status: "skipped",
      reason: "opted_out",
    });
    // The skip is durable too: the same key is now a duplicate even after opting in.
    const key = mail(companyId, userId);
    expect(outcomeOf(await sendUserEmail(key))).toBe("opted_out");
    await setEmailPreference(companyId, userId, "digest", { on: true, source: "settings" });
    expect(outcomeOf(await sendUserEmail(key))).toBe("duplicate");
    expect((await getEmailSend(companyId, key.dedupeKey))?.status).toBe("skipped");

    const unverified = await createUser(companyId, "office", { emailVerified: false });
    await setEmailPreference(companyId, unverified.id, "digest", { on: true, source: "settings" });
    expect(outcomeOf(await sendUserEmail(mail(companyId, unverified.id)))).toBe("unverified");

    const pin = await createUser(companyId, "presser", {
      email: `pin+${crypto.randomUUID()}@floor.invai.internal`,
    });
    await withSystem((tx) =>
      tx.update(members).set({ role: "presser" }).where(eq(members.userId, pin.id)),
    );
    await setEmailPreference(companyId, pin.id, "digest", { on: true, source: "settings" });
    expect(outcomeOf(await sendUserEmail(mail(companyId, pin.id)))).toBe("placeholder");

    const gone = await createUser(companyId, "office");
    await setEmailPreference(companyId, gone.id, "digest", { on: true, source: "settings" });
    await withSystem((tx) =>
      tx
        .update(members)
        .set({ status: "deactivated" })
        .where(and(eq(members.organizationId, companyId), eq(members.userId, gone.id))),
    );
    expect(outcomeOf(await sendUserEmail(mail(companyId, gone.id)))).toBe("not_member");
    // A person who is a member elsewhere but not here is not_member here either.
    const other = await shop("owner");
    expect(outcomeOf(await sendUserEmail(mail(companyId, other.userId)))).toBe("not_member");

    const bounced = await createUser(companyId, "office");
    await setEmailPreference(companyId, bounced.id, "digest", { on: true, source: "settings" });
    await suppressEmail(companyId, bounced.id, { reason: "bounce", detail: "550 no mailbox" });
    await suppressEmail(companyId, bounced.id, { reason: "complaint" }); // idempotent
    expect(outcomeOf(await sendUserEmail(mail(companyId, bounced.id)))).toBe("suppressed");

    const sample = await shop("owner");
    await setEmailPreference(sample.companyId, sample.userId, "digest", {
      on: true,
      source: "settings",
    });
    await withSystem((tx) =>
      tx
        .update(companies)
        .set({ demoOwnerUserId: sample.userId })
        .where(eq(companies.id, sample.companyId)),
    );
    clearSampleWorkspaceCache();
    expect(outcomeOf(await sendUserEmail(mail(sample.companyId, sample.userId)))).toBe(
      "sample_workspace",
    );
  });

  it("a preview bypasses only the opt-in; the kill switch skips everything without a row", async () => {
    const { companyId, userId } = await shop("owner");
    const preview = mail(companyId, userId, { kind: "digest_preview" });
    expect((await sendUserEmail(preview)).status).toBe("sent");
    const unverified = await createUser(companyId, "owner", { emailVerified: false });
    expect(
      outcomeOf(await sendUserEmail(mail(companyId, unverified.id, { kind: "digest_preview" }))),
    ).toBe("unverified");

    const flags = env as { DIGEST_EMAIL_ENABLED: boolean };
    const input = mail(companyId, userId);
    flags.DIGEST_EMAIL_ENABLED = false;
    try {
      expect(await sendUserEmail(input)).toEqual({ status: "skipped", reason: "disabled" });
    } finally {
      flags.DIGEST_EMAIL_ENABLED = true;
    }
    expect(await getEmailSend(companyId, input.dedupeKey)).toBeNull();
  });

  it("rejects malformed input before touching anything", async () => {
    const { companyId, userId } = await shop("owner");
    await expect(
      sendUserEmail(mail(companyId, userId, { messageId: "no-brackets" })),
    ).rejects.toThrow(/messageId/);
    await expect(sendUserEmail(mail(companyId, userId, { dedupeKey: "" }))).rejects.toThrow(
      /dedupeKey/,
    );
  });
});

describe("mail headers and footer (AC3)", () => {
  it("builds RFC 8058 headers bound to the person and kind, and a deterministic Message-ID", () => {
    const c = "11111111-1111-4111-8111-111111111111";
    const u = "22222222-2222-4222-8222-222222222222";
    const headers = unsubscribeHeaders(c, u, "digest");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const m = headers["List-Unsubscribe"]?.match(/^<([^>]+)>, <mailto:([^>]+)>$/);
    expect(m).not.toBeNull();
    const url = new URL(m?.[1] as string);
    expect(`${url.origin}`).toBe(new URL(env.BETTER_AUTH_URL).origin);
    const token = url.pathname.split("/l/")[1] as string;
    expect(verifyLinkToken(token)).toMatchObject({ k: "unsubscribe", c, u, r: "digest" });
    expect(m?.[2]).toContain(`@${mailDomain()}`);
    expect(buildMessageId("digest.abc.def")).toBe(`<digest.abc.def@${mailDomain()}>`);
    expect(() => buildMessageId("has space")).toThrow();
  });

  it("the footer carries why, unsubscribe, manage and the postal address in en and es", () => {
    const en = emailFooter({
      lang: "en",
      shopName: "Desert Bloom",
      unsubscribeUrl: "https://api.test/l/tok",
    });
    expect(en.text).toContain(
      "You get this because you turned on the weekly review for Desert Bloom.",
    );
    expect(en.text).toContain("Unsubscribe with one click: https://api.test/l/tok");
    expect(en.text).toContain(`Manage in Settings: ${env.WEB_ORIGIN}/settings/notifications`);
    expect(en.text).toContain(postalAddress());
    expect(en.html).toContain('href="https://api.test/l/tok"');
    const es = emailFooter({
      lang: "es",
      shopName: "Desert <Bloom>",
      unsubscribeUrl: "https://api.test/l/tok",
    });
    expect(es.text).toContain(
      "Recibes esto porque activaste el resumen semanal de Desert <Bloom>.",
    );
    expect(es.text).toContain("Administra en Configuración");
    expect(es.html).toContain("Desert &lt;Bloom&gt;");
    expect(postalAddress()).toContain("OI-12"); // the placeholder until the owner answers
  });
});
