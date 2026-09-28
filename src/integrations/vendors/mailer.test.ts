import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompany } from "../../test/fixtures";
import { sendMail } from "./mailer";

/*
 * S-36 (found reviewing T-19-4, wave 19): `sendMail` logged the raw recipient address on every
 * successful send. That was exercised only by vendor/invite mail before; T-19-4 now routes every
 * weekly digest through the same function, so the leak became per-tenant and recurring. The fix
 * logs `companyId` (when known) and a truncated hash of the address, never the address itself.
 */

describe("sendMail (S-36)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never writes the recipient's address to the log", async () => {
    const company = await createCompany({ name: `Mailer Tees ${crypto.randomUUID().slice(0, 8)}` });
    const to = `person-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await sendMail(
      { to, subject: `S-36 proof ${crypto.randomUUID().slice(0, 8)}`, text: "hi" },
      { companyId: company.id },
    );
    expect(result.messageId).toBeTruthy();

    const lines = logSpy.mock.calls.map((args) => args.join(" "));
    expect(lines.some((l) => l.includes(to))).toBe(false);
    // The company is still identifiable for support/ops, and the send is still tied to a "mail
    // sent" line -- just without the address itself.
    expect(lines.some((l) => l.includes("mail sent") && l.includes(company.id))).toBe(true);
  });

  it("account mail (no company) still logs nothing that identifies the recipient", async () => {
    const to = `account-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await sendMail({ to, subject: "verify your email", text: "hi" }, "account");

    const lines = logSpy.mock.calls.map((args) => args.join(" "));
    expect(lines.some((l) => l.includes(to))).toBe(false);
  });
});
