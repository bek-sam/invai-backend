import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * B-450: a database error after the mail went out must not cause a second email. Driven through the
 * real `sendUserEmail`; `sendMail` is replaced (and arms the failure), and `withTenant` is wrapped so
 * the next N tenant transactions reject once the mailer has answered, i.e. the settle writes.
 */

const probe = vi.hoisted(() => ({
  calls: 0,
  messageId: "test",
  fail: false,
  armed: false,
  reject: 0,
}));
vi.mock("../integrations/vendors/mailer", async (orig) => ({
  ...(await orig<typeof import("../integrations/vendors/mailer")>()),
  sendMail: vi.fn(async () => {
    probe.calls += 1;
    probe.armed = true;
    if (probe.fail) throw new Error("smtp down");
    return { messageId: probe.messageId };
  }),
}));
vi.mock("../db/client", async (orig) => {
  const actual = await orig<typeof import("../db/client")>();
  return {
    ...actual,
    withTenant: ((...args: Parameters<typeof actual.withTenant>) => {
      if (probe.armed && probe.reject > 0) {
        probe.reject -= 1;
        return Promise.reject(new Error("connection terminated"));
      }
      return actual.withTenant(...args);
    }) as typeof actual.withTenant,
  };
});

const { emailSends } = await import("../db/schema");
const { withTenant } = await import("../db/client");
const { createCompany, createUser } = await import("../test/fixtures");
const { MailSendError } = await import("./mail-errors");
const { buildMessageId, getEmailSend, sendUserEmail, setEmailPreference } = await import(
  "./notify"
);

const uniq = () => crypto.randomUUID().slice(0, 8);
const STALE = 11 * 60_000;

async function setup() {
  const company = await createCompany({ name: `Settle Tees ${uniq()}` });
  const user = await createUser(company.id, "owner");
  await setEmailPreference(company.id, user.id, "digest", { on: true, source: "settings" });
  const key = uniq();
  return {
    companyId: company.id,
    userId: user.id,
    input: {
      companyId: company.id,
      userId: user.id,
      kind: "digest" as const,
      dedupeKey: `digest:${key}:${user.id}`,
      messageId: buildMessageId(`digest.${key}.${user.id}`),
      subject: `T-51-5 ${key}`,
      text: "test",
      html: "<p>test</p>",
      unsubscribe: true,
    },
  };
}

/** Run one send with the next `n` settle writes failing, then disarm so the test can read the DB. */
async function sendWithSettleFailures(
  input: Awaited<ReturnType<typeof setup>>["input"],
  n: number,
) {
  probe.calls = 0;
  probe.reject = n;
  try {
    return await sendUserEmail(input);
  } finally {
    probe.armed = false;
    probe.reject = 0;
  }
}

beforeEach(() => {
  probe.calls = 0;
  probe.messageId = "test";
  probe.fail = false;
  probe.armed = false;
  probe.reject = 0;
});

describe("sendUserEmail after the mail went out (B-450, at most one email)", () => {
  it("one failed settle is retried and the row ends sent", async () => {
    const { companyId, input } = await setup();
    expect((await sendWithSettleFailures(input, 1)).status).toBe("sent");
    expect(probe.calls).toBe(1);
    expect((await getEmailSend(companyId, input.dedupeKey))?.status).toBe("sent");
    expect(await sendUserEmail(input)).toEqual({ status: "skipped", reason: "duplicate" });
    expect(probe.calls).toBe(1);
  });

  it("when every settle fails it still answers sent, and no retry, even a stale one, sends again", async () => {
    const { companyId, input } = await setup();
    const first = await sendWithSettleFailures(input, 3);
    expect(first).toMatchObject({ status: "sent" });
    expect(probe.calls).toBe(1);
    const row = await getEmailSend(companyId, input.dedupeKey);
    expect(row).toMatchObject({ status: "pending", reason: "sending" });

    expect(await sendUserEmail(input)).toEqual({ status: "skipped", reason: "duplicate" });
    await withTenant(companyId, (tx) =>
      tx
        .update(emailSends)
        .set({ updatedAt: new Date(Date.now() - STALE) })
        .where(eq(emailSends.id, row?.id as string)),
    );
    expect(await sendUserEmail(input)).toEqual({ status: "skipped", reason: "duplicate" });
    expect(probe.calls).toBe(1);
  });

  it("the mailer-skip path behaves the same: retried settle, then pending/sending and no second send", async () => {
    probe.messageId = "skipped:sample-workspace";
    const one = await setup();
    expect(await sendWithSettleFailures(one.input, 1)).toEqual({
      status: "skipped",
      reason: "sample_workspace",
    });
    expect(probe.calls).toBe(1);
    expect(await getEmailSend(one.companyId, one.input.dedupeKey)).toMatchObject({
      status: "skipped",
      reason: "sample_workspace",
    });

    const all = await setup();
    expect(await sendWithSettleFailures(all.input, 3)).toEqual({
      status: "skipped",
      reason: "sample_workspace",
    });
    expect(await getEmailSend(all.companyId, all.input.dedupeKey)).toMatchObject({
      status: "pending",
      reason: "sending",
    });
    expect(await sendUserEmail(all.input)).toEqual({ status: "skipped", reason: "duplicate" });
    expect(probe.calls).toBe(1);
  });

  it("a transport failure still marks the row failed and throws MailSendError", async () => {
    const { companyId, input } = await setup();
    probe.fail = true;
    probe.reject = 0;
    await expect(sendUserEmail(input)).rejects.toBeInstanceOf(MailSendError);
    expect(probe.calls).toBe(1);
    expect((await getEmailSend(companyId, input.dedupeKey))?.status).toBe("failed");
  });

  it("a failing failed-settle after a transport error still throws MailSendError", async () => {
    const { input } = await setup();
    probe.fail = true;
    probe.calls = 0;
    probe.reject = 1;
    await expect(sendUserEmail(input)).rejects.toBeInstanceOf(MailSendError);
    probe.armed = false;
  });
});
