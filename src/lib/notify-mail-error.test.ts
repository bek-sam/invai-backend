import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * B-441 / S-88 (S-29 class): a failed person-facing email must not put the recipient's address, or
 * the mail server's reply (which quotes it), in a log line, the `email_sends` row or the thrown
 * error. Driven through the real `sendUserEmail` and the digest delivery that calls it; only the
 * transport (`sendMail`) is replaced, by one that fails like nodemailer's SMTP errors.
 */

const probe = vi.hoisted(() => ({
  fail: null as null | ((to: string) => Error),
  addresses: [] as string[],
}));
vi.mock("../integrations/vendors/mailer", async (orig) => ({
  ...(await orig<typeof import("../integrations/vendors/mailer")>()),
  sendMail: vi.fn(async (mail: { to: string }) => {
    probe.addresses.push(mail.to);
    if (probe.fail) throw probe.fail(mail.to);
    return { messageId: "test" };
  }),
}));

const { withSystem, withTenant } = await import("../db/client");
const { digestDeliveries, digests } = await import("../db/schema");
const { deliverDigest } = await import("../modules/digest/deliver");
const { createCompany, createUser } = await import("../test/fixtures");
const { MailSendError, mailFailureReason } = await import("./mail-errors");
const { buildMessageId, getEmailSend, sendUserEmail, setEmailPreference } = await import(
  "./notify"
);

const uniq = () => crypto.randomUUID().slice(0, 8);

/** Shaped like nodemailer's SMTP rejection: the address is in message, response, command and stack. */
const smtpError = (to: string) => {
  const e = Object.assign(new Error(`Recipient rejected: <${to}> user unknown`), {
    response: `550 5.1.1 <${to}>: Recipient address rejected`,
    command: `RCPT TO:<${to}>`,
    code: "EENVELOPE",
    responseCode: 550,
  });
  e.stack = `Error: Recipient rejected: <${to}> user unknown\n    at SMTPConnection._formatError (/x/smtp-connection.js:1:1)`;
  return e;
};

/** Stack frames hold file paths (pnpm's `pkg@1.2.3` dirs), so "no @" is judged on the text with frames cut. */
const noFrames = (text: string) => text.replace(/(\\n|\n)\s+at [^\n"]*/g, "");

let captured: string[];
beforeEach(() => {
  captured = [];
  probe.fail = smtpError;
  probe.addresses = [];
  const grab = (...args: unknown[]) => void captured.push(args.map(String).join(" "));
  vi.spyOn(console, "error").mockImplementation(grab);
  vi.spyOn(console, "warn").mockImplementation(grab);
  vi.spyOn(console, "log").mockImplementation(grab);
});
afterEach(() => {
  probe.fail = null;
  vi.restoreAllMocks();
});

async function shop() {
  const company = await createCompany({ name: `B-441 Tees ${uniq()}` });
  const owner = await createUser(company.id, "owner");
  await setEmailPreference(company.id, owner.id, "digest", { on: true, source: "settings" });
  return { companyId: company.id, userId: owner.id };
}

function mail(companyId: string, userId: string) {
  const key = uniq();
  return {
    companyId,
    userId,
    kind: "digest" as const,
    dedupeKey: `digest:${key}:${userId}`,
    messageId: buildMessageId(`digest.${key}.${userId}`),
    subject: "B-441",
    text: "test",
    html: "<p>test</p>",
    unsubscribe: true,
  };
}

describe("sendUserEmail transport failure (B-441)", () => {
  it("logs, stores and throws no address; a retry with the same key takes the row over", async () => {
    const { companyId, userId } = await shop();
    const input = mail(companyId, userId);

    const err = await sendUserEmail(input).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(probe.addresses[0]).toContain("@"); // the failure really carried an address
    expect(err).toBeInstanceOf(MailSendError);
    expect(err?.name).toBe("MailSendError");
    expect(err?.message).toBe("mail transport failed (smtp_550)");
    expect(err?.cause).toBeUndefined();
    expect(noFrames(`${err?.message}\n${err?.stack}`)).not.toContain("@");
    expect(`${err?.message}\n${err?.stack}`).not.toContain(probe.addresses[0] ?? "?");

    const row = await getEmailSend(companyId, input.dedupeKey);
    expect(row).toMatchObject({ status: "failed", reason: "smtp_550" });
    expect(row?.reason).toMatch(/^[a-z0-9_]{1,40}$/);

    const line = captured.find((l) => l.includes("user email failed")) ?? "";
    expect(line).toContain('"reason":"smtp_550"');
    expect(line).toContain('"errorName":"Error"');
    expect(line).toContain('"code":"EENVELOPE"');
    expect(line).toContain('"responseCode":550');
    expect(line).toContain(`"kind":"digest"`);
    expect(line).toContain(companyId);
    expect(noFrames(captured.join("\n"))).not.toContain("@");
    expect(captured.join("\n")).not.toContain(probe.addresses[0] ?? "?");

    probe.fail = null;
    expect((await sendUserEmail(input)).status).toBe("sent");
    expect((await getEmailSend(companyId, input.dedupeKey))?.status).toBe("sent");
  });
});

describe("mailFailureReason vocabulary", () => {
  it("maps to smtp_<code>, transport_<code> or transport_error and never to free text", () => {
    expect(mailFailureReason({ responseCode: 421, code: "ECONNECTION" })).toBe("smtp_421");
    expect(mailFailureReason({ responseCode: 199, code: "ETIMEDOUT" })).toBe("transport_etimedout");
    expect(mailFailureReason({ responseCode: 600 })).toBe("transport_error");
    expect(mailFailureReason({ responseCode: 550.5 })).toBe("transport_error");
    expect(mailFailureReason({ responseCode: "550" })).toBe("transport_error");
    expect(mailFailureReason({ code: "a@b.c" })).toBe("transport_error");
    expect(mailFailureReason({ code: "bad code" })).toBe("transport_error");
    expect(mailFailureReason(new Error("x@y.z"))).toBe("transport_error");
    expect(mailFailureReason("boom <a@b.c>")).toBe("transport_error");
    expect(mailFailureReason(null)).toBe("transport_error");
    const long = mailFailureReason({ code: `E${"A".repeat(30)}` });
    expect(long).toMatch(/^[a-z0-9_]{1,40}$/);
  });
});

describe("digest delivery path (B-441)", () => {
  it("the digest email failed line and the delivery row carry no address", async () => {
    const { companyId, userId } = await shop();
    const [d] = await withSystem((tx) =>
      tx
        .insert(digests)
        .values({
          companyId,
          weekKey: "2026-W39",
          weekStart: "2026-09-21",
          weekEnd: "2026-09-28",
          periodFrom: new Date("2026-09-21T07:00:00.000Z"),
          periodTo: new Date("2026-09-28T07:00:00.000Z"),
          timezone: "America/Phoenix",
          status: "ready",
          readyAt: new Date("2026-09-28T07:00:00.000Z"),
        })
        .returning(),
    );
    if (!d) throw new Error("digest");

    // The delivery fails its job after settling every row, so the retry runs again.
    await expect(
      deliverDigest(companyId, d.id, new Date("2026-09-28T14:05:00.000Z")),
    ).rejects.toThrow("send_failed");
    expect(probe.addresses[0]).toContain("@");

    const line = captured.find((l) => l.includes("digest email failed")) ?? "";
    expect(line).toContain('"error":"mail transport failed (smtp_550)"');
    expect(captured.some((l) => l.includes("user email failed"))).toBe(true);
    expect(noFrames(captured.join("\n"))).not.toContain("@");
    expect(captured.join("\n")).not.toContain(probe.addresses[0] ?? "?");

    const rows = await withTenant(companyId, (tx) =>
      tx.select().from(digestDeliveries).where(eq(digestDeliveries.userId, userId)),
    );
    expect(rows[0]).toMatchObject({ status: "failed", reason: "send_failed" });
  });
});
