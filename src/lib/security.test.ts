import { describe, expect, it } from "vitest";
import { scrubAssistantRun } from "../ai/gateway";
import { decryptField, encryptField, signPayload, verifyPayload } from "./crypto";
import { neutralizeFormula, toCsv } from "./csv";
import { contentDisposition } from "./s3";

describe("field encryption", () => {
  it("uses a fresh 12-byte IV per value and a key id prefix", () => {
    const a = encryptField("Jane Buyer");
    const b = encryptField("Jane Buyer");
    expect(a).not.toBe(b);
    const [keyId, body] = a.split(":");
    expect(keyId).toMatch(/^\w+$/);
    expect(Buffer.from(body as string, "base64").length).toBe(12 + 16 + "Jane Buyer".length);
    expect(decryptField(a)).toBe("Jane Buyer");
  });

  it("rejects tampered data and truncated auth tags", () => {
    const stored = encryptField("123 Main St");
    const [keyId, body] = stored.split(":") as [string, string];
    const buf = Buffer.from(body, "base64");
    const flipped = Buffer.from(buf);
    flipped[buf.length - 1] = (flipped[buf.length - 1] as number) ^ 1;
    expect(() => decryptField(`${keyId}:${flipped.toString("base64")}`)).toThrow();
    // iv + a 4-byte tag only: must not be accepted as a short tag.
    expect(() => decryptField(`${keyId}:${buf.subarray(0, 16).toString("base64")}`)).toThrow();
    expect(() => decryptField(`nokey:${body}`)).toThrow(/Unknown encryption key/);
  });

  it("signed payloads fail on any change to body or signature", () => {
    const token = signPayload("s".repeat(32), { uid: "u1", exp: 1 });
    expect(verifyPayload("s".repeat(32), token)).toEqual({ uid: "u1", exp: 1 });
    expect(verifyPayload("t".repeat(32), token)).toBeNull();
    const [body, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ uid: "u2", exp: 1 })).toString("base64url");
    expect(verifyPayload("s".repeat(32), `${forged}.${sig}`)).toBeNull();
    expect(verifyPayload("s".repeat(32), `${body}.${sig.slice(0, -2)}`)).toBeNull();
  });
});

describe("CSV export", () => {
  it("neutralizes spreadsheet formulas but keeps numbers", () => {
    for (const v of ['=HYPERLINK("x")', "+1+1", "-2+3", "@SUM(A1)", "\t=1"])
      expect(neutralizeFormula(v)).toBe(`'${v}`);
    expect(neutralizeFormula(-12.5)).toBe("-12.5");
    expect(neutralizeFormula("-12.50")).toBe("-12.50");
    expect(neutralizeFormula("Retro tee")).toBe("Retro tee");
    expect(toCsv([{ title: '=cmd|" /C calc"!A0', price: 25 }])).toBe(
      'title,price\r\n"\'=cmd|"" /C calc""!A0",25',
    );
  });
});

describe("download names", () => {
  it("cannot break out of the Content-Disposition header", () => {
    const v = contentDisposition('evil".png\r\nSet-Cookie: x=1');
    expect(v).not.toMatch(/[\r\n]/);
    expect(v.startsWith('attachment; filename="evil_.png__Set-Cookie: x=1"')).toBe(true);
  });
});

describe("AI assistant input", () => {
  it("scrubs buyer data from the message and history before the provider sees it", () => {
    const run = scrubAssistantRun({
      system: "s",
      now: new Date(),
      tools: [],
      message: "Why is order for jane@example.com at 42 Palm Tree Rd, call 480-555-1234, late?",
      history: [{ role: "user", text: "ship to 7 Cactus Ln" }],
    });
    expect(run.message).not.toMatch(/jane@|Palm Tree|555-1234/);
    expect(run.history[0]?.text).not.toMatch(/Cactus Ln/);
  });
});
