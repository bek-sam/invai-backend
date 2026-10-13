import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * B-306 (S-29 class): a failed account email must not write the recipient's address, or the
 * mail server's reply (which quotes it), to the log. Driven through the real caller: Better
 * Auth's request-password-reset route -> `sendResetPassword` (src/auth.ts) -> `sendAuthMail`.
 * Only the transport (`sendMail`) is replaced, by one that fails like nodemailer's SMTP errors.
 */

const probe = vi.hoisted(() => ({ calls: 0, fail: null as null | ((to: string) => Error) }));
vi.mock("../integrations/vendors/mailer", async (orig) => ({
  ...(await orig<typeof import("../integrations/vendors/mailer")>()),
  sendMail: vi.fn(async (mail: { to: string }) => {
    probe.calls++;
    if (probe.fail) throw probe.fail(mail.to);
    return { messageId: "test" };
  }),
}));

const { app } = await import("../api/app");
const { env } = await import("../env");
const { AUTH_MAIL_TIMEOUT_MS, mailErrorFields, resetPasswordEmail, sendAuthMail } = await import(
  "./auth-mail"
);

const post = (path: string, body: unknown) =>
  app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.WEB_ORIGIN },
    body: JSON.stringify(body),
  });

const smtpError = (to: string) =>
  Object.assign(new Error(`Recipient rejected: <${to}>`), {
    name: "Error",
    code: "EENVELOPE",
    responseCode: 550,
    response: `550 5.1.1 <${to}>: Recipient address rejected: User unknown`,
    command: `RCPT TO:<${to}>`,
  });

function capture() {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  vi.spyOn(console, "error").mockImplementation(push);
  vi.spyOn(console, "log").mockImplementation(push);
  return lines;
}

beforeEach(() => {
  vi.restoreAllMocks();
  probe.calls = 0;
  probe.fail = null;
});

describe("account email failure log (B-306)", () => {
  it("through the reset route: no address, no SMTP reply text; kind and safe codes stay", async () => {
    const email = `mail-scrub-${Date.now()}@test.local`;
    expect(
      (await post("/sign-up/email", { email, password: "correct horse 1", name: "M" })).status,
    ).toBe(200);
    probe.calls = 0; // sign-up may send a verification mail; count only the reset
    probe.fail = smtpError;
    const lines = capture();

    const res = await post("/request-password-reset", {
      email,
      redirectTo: `${env.WEB_ORIGIN}/reset-password`,
    });
    // The caller's answer is the same whether or not delivery fails.
    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(lines.some((l) => l.includes("account email not sent"))).toBe(true),
    );

    const logged = lines.filter((l) => l.includes("account email not sent")).join("\n");
    expect(logged).toContain("reset_password");
    expect(logged).toContain("EENVELOPE");
    expect(logged).toContain("550");
    const all = lines.join("\n").toLowerCase();
    expect(all).not.toContain(email.toLowerCase());
    expect(all).not.toContain("@test.local");
    expect(all).not.toContain("user unknown");
    expect(all).not.toContain("rcpt to");
    expect(all).not.toContain("rejected");
  });

  it("a plain error whose message holds the address logs only its class name", async () => {
    probe.fail = (to) => new TypeError(`connect failed for ${to}`);
    const lines = capture();
    const ok = await sendAuthMail(
      "someone@example.com",
      "password_changed",
      resetPasswordEmail("en", "https://x.test/y"),
    );
    expect(ok).toBe(false);
    const logged = lines.join("\n");
    expect(logged).toContain("password_changed");
    expect(logged).toContain("TypeError");
    expect(logged.toLowerCase()).not.toContain("someone@example.com");
    expect(logged).not.toContain("connect failed");
  });

  it("a timeout is logged by its name, not its text", async () => {
    probe.fail = null;
    const { sendMail } = await import("../integrations/vendors/mailer");
    vi.mocked(sendMail).mockImplementationOnce(() => new Promise(() => {}));
    const lines = capture();
    const ok = await sendAuthMail(
      "a@example.com",
      "two_factor_on",
      resetPasswordEmail("en", "l"),
      5,
    );
    expect(ok).toBe(false);
    const logged = lines.join("\n");
    expect(logged).toContain("AuthMailTimeout");
    expect(logged).not.toContain("timed out");
    expect(AUTH_MAIL_TIMEOUT_MS).toBeGreaterThan(5);
  });

  it("mailErrorFields keeps only short code-shaped values", () => {
    expect(
      mailErrorFields(Object.assign(new Error("x@y.z"), { code: "a@b.c", responseCode: "550" })),
    ).toEqual({ errorName: "Error", code: undefined, responseCode: undefined });
    expect(mailErrorFields("boom <a@b.c>")).toEqual({
      errorName: "UnknownError",
      code: undefined,
      responseCode: undefined,
    });
  });
});
