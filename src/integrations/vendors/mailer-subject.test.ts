import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../../env";
import { hmacHex, sha256Hex } from "../../lib/crypto";
import { createCompany } from "../../test/fixtures";
import { sendMail, subjectLogFields } from "./mailer";

/*
 * B-139: digest subjects carry the shop name and weekly net profit, so the log gets the template
 * key and a short hash of the subject, never the subject text.
 */
describe("sendMail subject logging (B-139)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the template key and a subject hash, never the subject", async () => {
    const company = await createCompany({
      name: `Subject Tees ${crypto.randomUUID().slice(0, 8)}`,
    });
    const subject = `Desert Bloom Tees made $1,234.56 this week ${crypto.randomUUID().slice(0, 8)}`;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendMail(
      { to: "owner@example.com", subject, text: "hi", template: "digest.weekly" },
      { companyId: company.id },
    );

    const lines = [...logSpy.mock.calls, ...warnSpy.mock.calls].map((a) => a.join(" "));
    const mailLines = lines.filter((l) => l.includes("mail "));
    expect(mailLines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes(subject) || l.includes("$1,234.56"))).toBe(false);
    expect(mailLines.some((l) => l.includes("digest.weekly"))).toBe(true);
    expect(mailLines.some((l) => l.includes(subjectLogFields({ subject }).subjectHash))).toBe(true);
  });

  it("hash is stable and short; the template is null when the caller gives none", () => {
    const a = subjectLogFields({ subject: "Sheet 12 for Sun City DTF" });
    expect(a).toEqual(subjectLogFields({ subject: "Sheet 12 for Sun City DTF" }));
    expect(a.subjectHash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.template).toBeNull();
    expect(subjectLogFields({ subject: "other" }).subjectHash).not.toBe(a.subjectHash);
  });

  it("keys the hash (S-38): not the plain sha256 of the subject, and doesn't move the template key", () => {
    const subject = "Your week at Desert Bloom Tees: net profit $1,428.55 (+12%)";
    const fields = subjectLogFields({ subject, template: "digest.weekly" });
    // An unkeyed sha256Hex is reversible in seconds for a low-entropy template like this one
    // (S-38): the stored hash must not equal it, so brute-forcing the subject needs the secret too.
    expect(fields.subjectHash).not.toBe(sha256Hex(subject).slice(0, 16));
    expect(fields.subjectHash).toMatch(/^[0-9a-f]{16}$/);
    expect(fields.template).toBe("digest.weekly");
    // Keying is per-secret: the same subject hashed with a different key must differ, proving the
    // hash depends on BETTER_AUTH_SECRET and not just on the subject text.
    expect(fields.subjectHash).not.toBe(
      hmacHex(`${env.BETTER_AUTH_SECRET}-different`, subject).slice(0, 16),
    );
  });
});
