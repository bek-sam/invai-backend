import { describe, expect, it } from "vitest";
import { formatValue } from "../modules/digest/facts";
import { stripPii, stripPiiDeep } from "./pii";
import { validateNarrative } from "./validators/digest";

/* T-52-1 (R-B454, S-91): international and Mexican phone numbers are scrubbed, ordinary shop numbers are not. */

const PHONES = [
  "+16025550143",
  "+1 602 555 0143",
  "+52 55 1234 5678",
  "+52 1 55 1234 5678",
  "+44 20 7946 0958",
  "+44 (0)20 7946 0958",
  "+49 30 901820",
  "55 1234 5678",
  "(55) 1234-5678",
  "56 1234 5678",
  "33 1234 5678",
  "81.1234.5678",
  "602-555-0143",
  "(602) 555-0143",
  "602.555.0143",
  "1-602-555-0143",
];

describe("stripPii phones", () => {
  it.each(PHONES)("scrubs %s", (p) => {
    const out = stripPii(`Call me on ${p} after five`);
    expect(out).toContain("[phone]");
    expect(out).not.toMatch(/\d{7,}/);
    expect(out.replace(/\D/g, "").length).toBeLessThan(2);
  });

  it("scrubs the whole number, nothing of it left, in running text", () => {
    expect(stripPii("Tel +52 1 55 1234 5678.")).toBe("Tel [phone].");
    expect(stripPii("Tel: +44 (0)20 7946 0958, thanks")).toBe("Tel: [phone], thanks");
    expect(stripPii("(55) 1234-5678")).toBe("[phone]");
  });

  it("keeps a date or count that follows a phone", () => {
    expect(stripPii("+52 55 1234 5678 2026-10-14")).toBe("[phone] 2026-10-14");
    expect(stripPii("+52 55 1234 5678, 3 units")).toBe("[phone], 3 units");
  });

  it("a number glued to a digit, percent or decimal is not an international phone", () => {
    expect(stripPii("+12345678%")).toBe("+12345678%");
    expect(stripPii("+12345678.5")).toBe("+12345678.5");
    expect(stripPii("+12345678,5")).toBe("+12345678,5");
  });

  it("a plus after a digit or another plus is not a phone start", () => {
    // T-53-1 A2 (authorized tightening): a plus glued to a word is now a phone, `a+16025550143` was kept before.
    expect(stripPii("a+16025550143")).toBe("a[phone]");
    expect(stripPii("++16025550143")).toBe("++16025550143");
    expect(stripPii("1+16025550143")).toBe("1+16025550143");
  });

  it("two parenthesised groups are not one phone", () => {
    expect(stripPii("+44 (0)20 (7946) 0958")).toBe("+44 (0)20 (7946) 0958");
  });

  it("order ids that look like phones or cards stay scrubbed (ruled: buyer-linkable keys)", () => {
    expect(stripPii("order 3310000001")).toBe("order [phone]");
    expect(stripPii("order 113-1234567-1234567 ok")).not.toMatch(/\d/);
    expect(stripPii("order 113-1234567-1234567")).toBe("order [number]");
  });

  it("still scrubs emails, addresses, cards and ZIP+4", () => {
    expect(stripPii("a@b.com")).toBe("[email]");
    expect(stripPii("2140 E Camelback Rd")).toBe("[address]");
    expect(stripPii("card 4111 1111 1111 1111")).toBe("card [number]");
    expect(stripPii("85003-1234")).toBe("[zip]");
  });
});

const KEEP = [
  "#1042",
  "1042",
  "TEE-BLK-XL",
  "G500-BLK-2XL",
  "12 x 16 in",
  "10.5x12",
  "$19.99",
  "1,234.50",
  "$12,345,678.00",
  "+$1,234.50",
  "+6.5%",
  "+12.5%",
  "-12.5 %",
  "+12 orders",
  "+1,234",
  "+1234567 orders",
  "-3",
  "2026-10-14",
  "14/10/2026",
  "10:30",
  "Sep 27",
  "27 sep",
  "2026-10-14T10:30:00.000Z",
  "1990-2024",
  "3 units",
  "85003",
  "10 2024-2025",
  "TEE_BLK_XL",
  "G500_BLK_2XL",
  "SKU_602_555_0143",
  "1990\u20132024",
  "10 1990\u20132024",
  "10 2024\u20132025",
  "2026/10/14",
  "10/14/2026",
  "1 / 2",
  "12\u00A0x\u00A016\u00A0in",
  "55123456-1234-5678-9012-345678901234",
  "{{market.55123456-1234-5678-9012-345678901234.asOf}}",
  "insight 12345678-1234-1234-1234-123456789012 done",
];

describe("stripPii keeps ordinary shop text", () => {
  it.each(KEEP)("keeps %s", (t) => {
    expect(stripPii(t)).toBe(t);
    expect(stripPii(`Total ${t} today`)).toBe(`Total ${t} today`);
  });

  it("an all-digit UUID next to a phone: the UUID survives, the phone goes", () => {
    const id = "55123456-1234-5678-9012-345678901234";
    expect(stripPii(`${id} call +52 55 1234 5678 ${id}`)).toBe(`${id} call [phone] ${id}`);
  });

  it("restores every UUID in order, including more than 26 of them", () => {
    const ids = Array.from(
      { length: 30 },
      (_, i) => `${10000000 + i}-1234-1234-1234-${123456789000 + i}`,
    );
    const text = ids.join(" | ");
    expect(stripPii(text)).toBe(text);
  });
});

describe("stripPii stays linear on adversarial input (S-91 r1)", () => {
  const BOUND_MS = 1000;
  const shapes: [string, string][] = [
    ["one long + run with separators", `+${"1 ".repeat(100_000)}`],
    ["one long + digit run", `+${"1".repeat(200_000)}`],
    ["long run with dash groups", `+${"12-".repeat(70_000)}`],
    ["repeated +1 fragments", "+1 ".repeat(70_000)],
    ["a chain of glued emails", "a@b.cc.".repeat(29_000)],
    ["a long digit run with no @", "1".repeat(200_000)],
    ["a long local-part run before one @", `${"a".repeat(200_000)}@x`],
    ["a long domain run with no tld", `a@${"1.".repeat(100_000)}`],
    ["repeated @ with no domain", "a@".repeat(100_000)],
  ];
  it.each(shapes)("200 KB: %s", (_name, text) => {
    const t0 = performance.now();
    stripPii(text);
    expect(performance.now() - t0).toBeLessThan(BOUND_MS);
  });
});

describe("stripPii scrubs every email, even glued together (S-91 r3)", () => {
  it.each([
    ["a@b.com.d@x.com", "[email][email]"],
    ["a@b.com-c@d.com", "[email][email]"],
    ["x@y.co1z@w.com", "[email][email]"],
    ["x.com.bob@yahoo.com", "[email]"],
    ["jo@x.com.bob@yahoo.com", "[email]"],
    ["a1.b@x.com", "[email]"],
    ["x123@y.co", "[email]"],
    ["foo_a@x.com", "[email]"],
    ["name:jo@x.com", "name:[email]"],
    ["12.5 a1.b@x.com", "12.5 [email]"],
    ["a.b+tag@ex.co.uk", "[email]"],
    ["foo@bar@x.com", "foo@[email]"],
    ["mail jo@x.com, ana@y.mx", "mail [email], [email]"],
    ["@x.com", "@x.com"],
  ])("%s -> %s", (text, out) => {
    expect(stripPii(text)).toBe(out);
  });

  it("a chain of 1000 joined emails is fully scrubbed, fast", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `u${i}@d${i}.com`).join(".");
    const t0 = performance.now();
    const out = stripPii(text);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out).not.toMatch(/@/);
    expect(out.match(/\[email\]/g)).toHaveLength(1000);
  });
});

/* T-53-1 (B-458, S-92): more phone separators and email forms. */

const NBSP = " ";
const NNBSP = " ";
const PHONE_FORMS = [
  "call+525512345678",
  "tel:+16025550143",
  "602  555  0143",
  "+52  55  1234  5678",
  "602/555/0143",
  "+52/55/1234/5678",
  "602_555_0143",
  `602${NBSP}555${NBSP}0143`,
  `602${NNBSP}555${NNBSP}0143`,
  `+52${NBSP}55${NBSP}1234${NBSP}5678`,
  `+52${NNBSP}55${NNBSP}1234${NNBSP}5678`,
  "602–555–0143",
  "602‒555‒0143",
  "602—555—0143",
  "+52 - 55 - 1234 - 5678",
  "+1 – 602 – 555 – 0143",
];

describe("stripPii phone separators (T-53-1)", () => {
  it.each(PHONE_FORMS)("scrubs %s", (p) => {
    const out = stripPii(`Call me on ${p} after five`);
    const word = /^[a-z]+:?(?=\+)/.exec(p)?.[0] ?? "";
    expect(out).toBe(`Call me on ${word}[phone] after five`);
    expect(out).not.toMatch(/\d{2,}/);
  });

  it("keeps a date after a phone whole (trim goes back to a whitespace boundary)", () => {
    expect(stripPii("+52 55 1234 5678 14/10/2026")).toBe("[phone] 14/10/2026");
    expect(stripPii("+52 55 1234 5678 14-10-2026")).toBe("[phone] 14-10-2026");
    expect(stripPii("+52 55 1234 5678 2026-10-14")).toBe("[phone] 2026-10-14");
  });

  it("rules: a Mexican number shape stays scrubbed with an en dash range", () => {
    expect(stripPii("55 1990–2024")).toBe("[phone]");
    expect(stripPii("55 1990-2024")).toBe("[phone]");
  });

  it("a SKU with underscores is kept, a phone alone in an underscore token is scrubbed", () => {
    expect(stripPii("SKU_602_555_0143")).toBe("SKU_602_555_0143");
    expect(stripPii("x 602_555_0143 y")).toBe("x [phone] y");
  });

  it("two phones glued by a separator are both scrubbed", () => {
    expect(stripPii("602-555-0143 /602 555 0144")).not.toMatch(/\d{4}/);
    expect(stripPii("+16025550143/+16025550144")).not.toMatch(/\d{5}/);
  });
});

const EMAIL_FORMS: [string, string][] = [
  ['"jo smith"@x.com', "[email]"],
  ['mail "jo smith"@x.com now', "mail [email] now"],
  ["o'brien@x.com", "[email]"],
  ["x o'brien@x.com y", "x [email] y"],
  ["'jo@x.com'", "'[email]'"],
  ["’jo@x.com’", "’[email]’"],
  ["jo@münchen.de", "[email]"],
  ["jo@xn--mnchen-3ya.de", "[email]"],
  ["jo@[192.0.2.4]", "[email]"],
  ["jo@[IPv6:2001:db8::1]", "[email]"],
  ["12345678-1234-1234-1234-123456789012@x.com", "[email]"],
  ["a@@x.com", "[email]"],
  ["@@x.com", "@@x.com"],
  ["see @x.com", "see @x.com"],
  ["foo@bar@x.com", "foo@[email]"],
  ["'@x.com", "'@x.com"],
  ["o\u2019brien@x.com", "[email]"],
  [`"${"a".repeat(64)}"@x.com`, "[email]"],
  // T-54-4 A4.4 (authorized tightening): the quoted bound went from 64 to 254, so 65 chars is now scrubbed.
  [`"${"a".repeat(65)}"@x.com`, "[email]"],
  ['"ef@x.com"@y.com', '"[email]"@y.com'],
];

describe("stripPii email forms (T-53-1)", () => {
  it.each(EMAIL_FORMS)("%s -> %s", (text, out) => {
    expect(stripPii(text)).toBe(out);
  });

  it.each([
    ['"a b"@x.com."c d"@y.com', "[email][email]"],
    ["o'brien@x.com-o'neil@y.com", "[email][email]"],
    ["jo@[1.2.3.4]5ana@y.com", "[email][email]"],
    [
      "12345678-1234-1234-1234-123456789012@x.com.12345678-1234-1234-1234-123456789012@y.com",
      "[email][email]",
    ],
    ["a@@x.com7b@@y.com", "[email][email]"],
    ['"a b"@x.com "c d"@y.com', "[email] [email]"],
    ["o'brien@x.com o'neil@y.com", "[email] [email]"],
    ["jo@[1.2.3.4] 5ana@y.com", "[email] [email]"],
    ["a@@x.com b@@y.com", "[email] [email]"],
  ])("glued or spaced pair %s", (text, out) => {
    expect(stripPii(text)).toBe(out);
    expect(stripPii(text)).not.toMatch(/@/);
  });

  it("an email next to a UUID: the UUID survives, the email goes", () => {
    const id = "55123456-1234-5678-9012-345678901234";
    expect(stripPii(`${id} jo@x.com ${id}`)).toBe(`${id} [email] ${id}`);
  });
});

describe("stripPii stays linear on the T-53-1 shapes", () => {
  const BOUND_MS = 1000;
  const uuid = "12345678-1234-1234-1234-123456789012";
  const shapes: [string, string][] = [
    ["+ then 12/ runs", `+${"12/".repeat(70_000)}`],
    ["+ then 1 and two NBSPs", `+${`1${NBSP}${NBSP}`.repeat(70_000)}`],
    ["+ then 12 and en dash", `+${"12–".repeat(70_000)}`],
    ["+ then two spaces and dash", `+${"1  -".repeat(50_000)}`],
    ["a+1 repeated", "a+1 ".repeat(50_000)],
    ["+1 then a 200k separator run", `+1${" ".repeat(200_000)}`],
    ["602 then a 200k dash run", `602${"-".repeat(200_000)}555`],
    ["602 and 555 groups with 200k NBSP between", `602${NBSP.repeat(200_000)}555`],
    ["many 123 groups with separator runs", `123${NBSP}${NBSP}`.repeat(30_000)],
    ["55 then a 200k slash run", `55${"/".repeat(200_000)}1234`],
    ["1_ runs", "1_".repeat(100_000)],
    ["1// runs", "1//".repeat(70_000)],
    ["quotes then one @", `${'"'.repeat(200_000)}@x.com`],
    ["a quote @ repeated", 'a"@b.cc '.repeat(25_000)],
    ["a, many @, domain", `a${"@".repeat(200_000)}x.com`],
    ["a@@x.com repeated", "a@@x.com".repeat(25_000)],
    ["IP literal open run", `a@[${"1.".repeat(100_000)}`],
    ["a@ then umlauts", `a@${"ü".repeat(200_000)}`],
    ["apostrophes then one @", `${"'".repeat(200_000)}@x.com`],
    ["uuid emails repeated", `${uuid}@x.com `.repeat(5_000)],
    ["1 MB quotes then one @", `${'"'.repeat(1_000_000)}@x.com`],
    ["1 MB + run with separators", `+${"1 ".repeat(500_000)}`],
    ["1 MB glued emails", "a@b.cc.".repeat(150_000)],
  ];
  it.each(shapes)("%s", (_name, text) => {
    const t0 = performance.now();
    stripPii(text);
    expect(performance.now() - t0).toBeLessThan(BOUND_MS);
  });
});

describe("stripPiiDeep", () => {
  it("scrubs a phone inside a nested object", () => {
    const out = stripPiiDeep({ a: { b: { note: "ring +52 55 1234 5678 please" } }, n: 3 });
    expect(out).toEqual({ a: { b: { note: "ring [phone] please" } }, n: 3 });
  });

  it("scrubs a new phone form and a new email form in nested values (T-53-1)", () => {
    const out = stripPiiDeep({
      a: { b: ["ring 602/555/0143 ok", { c: 'mail "jo smith"@x.com' }] },
      d: [["tel:+16025550143"], "o'brien@x.com"],
    });
    expect(out).toEqual({
      a: { b: ["ring [phone] ok", { c: "mail [email]" }] },
      d: [["tel:[phone]"], "[email]"],
    });
  });

  it("scrubs a phone inside an array", () => {
    const out = stripPiiDeep(["ok", ["ring (55) 1234-5678"], { x: ["+44 20 7946 0958"] }]);
    expect(out).toEqual(["ok", ["ring [phone]"], { x: ["[phone]"] }]);
  });
});

describe("digest narrative false positives (AC4)", () => {
  const uuid = "55123456-1234-5678-9012-345678901234";
  const ids = ["glance.net", "d2.orders.changePct", "d12.3.unitCost", `market.${uuid}.asOf`];
  const insight = (id: string, factIds: string[]) => ({ id, kind: "action" as const, factIds });
  const facts = ids.map((id) => ({ id, formatted: { en: "x", es: "x" } }));
  const input = {
    lang: "en" as const,
    insights: [insight("ins1", ids), insight("ins2", ids)],
    facts,
  };
  const out = (texts: string[]) => ({
    lang: "en",
    headline: "Your week",
    items: [
      { insightId: "ins1", text: texts[0] },
      { insightId: "ins2", text: texts[1] },
    ],
  });
  const paras = [
    "Net came to {{glance.net}} this week.",
    "Orders moved {{d2.orders.changePct}} since last week.",
    "Unit cost is {{d12.3.unitCost}} for the top design.",
    `Data as of {{market.${uuid}.asOf}}, per the source.`,
    "Net {{glance.net}}, change {{d2.orders.changePct}}, cost {{d12.3.unitCost}}, as of {{market." +
      uuid +
      ".asOf}}.",
  ];

  it.each(paras)("passes without a pii rule: %s", (p) => {
    const v = validateNarrative(out([p, p]), input);
    expect(v.ok ? [] : v.failedRules).not.toContain("pii");
    expect(stripPii(p)).toBe(p);
  });

  it("every formatValue unit in en and es is unchanged by stripPii", () => {
    const cases: [Parameters<typeof formatValue>[0], number | string][] = [
      ["cents", 123450],
      ["cents", 1234567800],
      ["count", 1234],
      ["count", 1234567],
      ["pct", 6.5],
      ["pct", -12.5],
      ["ratio", 0.123],
      ["hours", 36.5],
      ["date", "2026-09-27"],
    ];
    for (const [unit, v] of cases) {
      for (const lang of ["en", "es"] as const) {
        const text = formatValue(unit, v, lang);
        expect(stripPii(text), `${unit} ${lang} ${text}`).toBe(text);
      }
    }
  });
});

/* T-54-4 (S-93): the last phone and email forms, with the keep list around them. */

const SEPS: [string, string][] = [
  ["tab", "\t"],
  ["thin space U+2009", "\u2009"],
  ["U+2000", "\u2000"],
  ["U+200A", "\u200A"],
  ["U+205F", "\u205F"],
  ["ideographic space U+3000", "\u3000"],
  ["zero-width U+200B", "\u200B"],
  ["U+2060", "\u2060"],
  ["U+FEFF", "\uFEFF"],
  ["tilde", "~"],
  ["middle dot", "\u00B7"],
  ["fullwidth hyphen U+FF0D", "\uFF0D"],
  ["fullwidth full stop U+FF0E", "\uFF0E"],
  ["fullwidth solidus U+FF0F", "\uFF0F"],
  ["fullwidth low line U+FF3F", "\uFF3F"],
  ["four spaces", "    "],
  ["eight tabs", "\t".repeat(8)],
];

describe("stripPii phone separators and fullwidth digits (T-54-4)", () => {
  it.each(SEPS)("US number joined by %s", (_n, sep) => {
    const out = stripPii(`call 602${sep}555${sep}0143 now`);
    expect(out).toBe("call [phone] now");
  });

  it.each(SEPS)("international number joined by %s", (_n, sep) => {
    expect(stripPii(`x +52${sep}55${sep}1234${sep}5678 y`)).toBe("x [phone] y");
  });

  it.each([
    "\uFF16\uFF10\uFF12-\uFF15\uFF15\uFF15-\uFF10\uFF11\uFF14\uFF13",
    "\uFF0B\uFF15\uFF12 \uFF15\uFF15 \uFF11\uFF12\uFF13\uFF14 \uFF15\uFF16\uFF17\uFF18",
    "\uFF08\uFF15\uFF15\uFF09\uFF11\uFF12\uFF13\uFF14\uFF0D\uFF15\uFF16\uFF17\uFF18",
    "\uFF0B\uFF11 602 555 0143",
    "\uFF11-602-555-0143",
    "+1 \uFF16\uFF10\uFF12 555 0143",
    "\uFF08602\uFF09 555-0143",
  ])("fullwidth form %s leaves no digits", (p) => {
    const out = stripPii(`tel ${p} ok`);
    expect(out).toBe("tel [phone] ok");
  });

  it("a fullwidth date or count after a phone stays whole", () => {
    expect(stripPii("+52 55 1234 5678\t14/10/2026")).toBe("[phone]\t14/10/2026");
    expect(stripPii("+52 55 1234 5678 \uFF12\uFF10\uFF12\uFF16-10-14")).toBe(
      "[phone] \uFF12\uFF10\uFF12\uFF16-10-14",
    );
  });

  it("a fullwidth digit joins the digit run; a fullwidth decimal after eight digits is not a phone", () => {
    expect(stripPii("+12345678\uFF15")).toBe("[phone]");
    expect(stripPii("+12345678\uFF0E5")).toBe("+12345678\uFF0E5");
  });

  it("a word before a fullwidth digit run is not a phone start (lookbehind)", () => {
    expect(stripPii("A\uFF16\uFF10\uFF12 555 0143")).toBe("A\uFF16\uFF10\uFF12 555 0143");
    expect(stripPii("\uFF11602 555 0143x")).toBe("\uFF11602 555 0143x");
  });

  it.each([
    "10~12 in",
    "2024~2025",
    "10 \u00B7 2024 \u00B7 2025",
    "Qty\t3\t$19.99",
    "1990\u30002024",
    "\uFF11\uFF12 x \uFF11\uFF16 in",
    "\uFF11\uFF10\uFF14\uFF12",
    "2026\uFF0D10\uFF0D14",
    "Sizes S\u00B7M\u00B7L\u00B7XL",
    "TEE~BLK~XL",
    "price 12\u200B34",
  ])("keeps ordinary text: %s", (t) => {
    expect(stripPii(t)).toBe(t);
  });

  it("ruled scrubbed, same as a dash today: tilde SKU digits and tab-joined 2-4-4", () => {
    expect(stripPii("SKU~602~555~0143")).toBe("SKU~[phone]");
    expect(stripPii("55\t2024\t2025")).toBe("[phone]");
  });
});

describe("stripPii email forms (T-54-4)", () => {
  it.each([
    ['"jo\\"smith"@x.com', "[email]"],
    ['"jo@smith"@x.com', "[email]"],
    ["jo\uFF20x.com", "[email]"],
    ["jo\uFE6Bx.com", "[email]"],
    ["jo@x\uFF0Ecom", "[email]"],
    ["jo@x\u3002com", "[email]"],
    ["jo\u200Bsmith@x.com", "[email]"],
    ["jo\u00ADsmith@x.com", "[email]"],
    ["jo@x\u200B.com", "[email]"],
    ["\u{1D423}\u{1D428}@x.com", "[email]"],
    ["ab\u{1D423}\u{1D428}cd@x.com", "[email]"],
    ["foo\uFF20\uFF20x.com", "[email]"],
    ["jo@a\uFF0Eb\uFF0Ecom", "[email]"],
    ["a@b.cc\uDC00@x.com", "[email]\uDC00@x.com"],
    [`"${"a".repeat(254)}"@x.com`, "[email]"],
    [`"${"a".repeat(255)}"@x.com`, "[email]"],
  ])("%s -> %s", (text, out) => {
    expect(stripPii(text)).toBe(out);
  });

  it("an @ inside a quoted local part no longer stops the scan (pin for the removed stop)", () => {
    expect(stripPii('mail "jo@smith"@x.com now')).toBe("mail [email] now");
  });

  it("a newline no longer stops the quoted scan (T-55-1, A1.7: authorized flip)", () => {
    expect(stripPii('"jo\nsmith"@x.com')).toBe("[email]");
  });

  it("an even run of backslashes does not escape the quote", () => {
    expect(stripPii('"a\\\\"b"@x.com')).toBe('"a\\\\[email]');
  });

  it.each([
    ['"a b"@x.com.\u200B"c d"@y.com', "[email][email]"],
    ["jo\uFF20x.com-ab\uFF20y.com", "[email][email]"],
    ["jo@x\uFF0Ecom1ana@y.com", "[email][email]"],
    ["\u{1D423}@x.com \u{1D428}@y.com", "[email] [email]"],
    ["\u{1D423}@x.com.\u{1D428}@y.com", "[email][email]"],
    ['"jo\\"s"@x.com 7 "a@b"@y.com', "[email] 7 [email]"],
    ["jo\u200B@x.com-ab\u200B@y.com", "[email][email]"],
  ])("glued: %s -> %s", (text, out) => {
    expect(stripPii(text)).toBe(out);
  });
});

describe("stripPiiDeep with the T-54-4 forms", () => {
  it("scrubs a new phone form and a new email form in nested values and arrays", () => {
    const out = stripPiiDeep({
      a: { b: ["ring 602\t555\t0143 ok", { c: "mail jo\uFF20x.com" }] },
      d: [
        ["tel \uFF0B\uFF15\uFF12 \uFF15\uFF15 \uFF11\uFF12\uFF13\uFF14 \uFF15\uFF16\uFF17\uFF18"],
        '"a\\"b"@x.com',
      ],
    });
    expect(out).toEqual({
      a: { b: ["ring [phone] ok", { c: "mail [email]" }] },
      d: [["tel [phone]"], "[email]"],
    });
  });
});

describe("stripPii stays linear on the T-54-4 shapes", () => {
  const BOUND_MS = 1000;
  const KB200 = 200_000;
  const shapes: [string, string][] = [
    ["+ then 12 and tab", `+${"12\t".repeat(70_000)}`],
    ["+ then 1 and thin space", `+${"1\u2009".repeat(100_000)}`],
    ["+ then 12 and U+3000 pairs", `+${"12\u3000\u3000".repeat(50_000)}`],
    ["+ then 1 and tilde", `+${"1~".repeat(100_000)}`],
    ["+ then 1 and middle dot", `+${"1\u00B7".repeat(100_000)}`],
    ["+ then 1 and fullwidth hyphen", `+${"1\uFF0D".repeat(100_000)}`],
    ["+ then 1 and zero-width", `+${"1\u200B".repeat(100_000)}`],
    ["+ then 1 and 8-wide tabs", `+${`1${"\t".repeat(8)}`.repeat(20_000)}`],
    ["+ then 1 and 9-wide tabs", `+${`1${"\t".repeat(9)}`.repeat(20_000)}`],
    ["fullwidth + then fullwidth digits", `\uFF0B${"\uFF11 ".repeat(100_000)}`],
    ["fullwidth digit run", "\uFF11".repeat(KB200)],
    ["fullwidth digits with parens", `\uFF0B${"\uFF08\uFF11\uFF09".repeat(60_000)}`],
    ["602 then a 200k tab run", `602${"\t".repeat(KB200)}555`],
    ["602 then a 200k U+3000 run", `602${"\u3000".repeat(KB200)}555`],
    ["55 then a 200k tilde run", `55${"~".repeat(KB200)}1234`],
    ["many 123 groups with tabs", `123\t\t`.repeat(30_000)],
    ["many fullwidth 123 groups", "\uFF11\uFF12\uFF13\u3000".repeat(40_000)],
    ["fullwidth at repeated", "a\uFF20".repeat(100_000)],
    ["a, many fullwidth at, domain", `a${"\uFF20".repeat(KB200)}x.com`],
    ["a@@x.com with fullwidth at repeated", "a\uFF20\uFF20x.com".repeat(25_000)],
    ["quotes with backslashes then one @", `${'"\\'.repeat(100_000)}@x.com`],
    ["backslash run then quote then @", `"${"\\".repeat(KB200)}"@x.com`],
    ["escaped quotes then @ repeated", '"\\"@b.cc '.repeat(25_000)],
    ["1 MB backslash quotes then one @", `${'"\\'.repeat(500_000)}@x.com`],
    ["escaped quote then @ repeated, no opener", '\\"@b.cc '.repeat(25_000)],
    ["1 MB escaped quote then @ repeated, no opener", '\\"@b.cc '.repeat(125_000)],
    ["zero-width run before one @", `${"\u200B".repeat(KB200)}@x.com`],
    ["zero-width a pairs before one @", `${"a\u200B".repeat(100_000)}@x.com`],
    ["astral letters before one @", `${"\u{1D423}".repeat(100_000)}@x.com`],
    ["astral letters and @ repeated", "\u{1D423}@b.cc.".repeat(25_000)],
    ["lone low surrogates before @", `${"\uDC00".repeat(KB200)}@x.com`],
    ["fullwidth dot domain run", `a@${"1\uFF0E".repeat(100_000)}`],
    ["zero-width domain run", `a@${"1\u200B".repeat(100_000)}`],
    ["a long quoted run (254) repeated", `"${"a".repeat(250)}"@b.cc`.repeat(700)],
    ["quote then 300 chars then @ repeated", `"${"a".repeat(300)}"@b.cc `.repeat(600)],
  ];
  it.each(shapes)("%s", (_name, text) => {
    const t0 = performance.now();
    stripPii(text);
    expect(performance.now() - t0).toBeLessThan(BOUND_MS);
  });
});

describe("stripPii last phone and email forms (T-55-1, S-94)", () => {
  const nd = (s: string) => (s.match(/\p{Nd}/gu) ?? []).length;
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => String.fromCharCode(from + i));
  const OLD_SEPS = [
    " ",
    "\t",
    ".",
    "-",
    "/",
    "_",
    "~",
    "\u00B7",
    "\u00A0",
    "\u202F",
    ...range(0x2000, 0x200d),
    ...range(0x2010, 0x2015),
    "\u205F",
    "\u2060",
    "\u2212",
    "\u3000",
    "\uFEFF",
    "\uFF0D",
    "\uFF0E",
    "\uFF0F",
    "\uFF3F",
  ];
  const NEW_SEPS: [string, string][] = [
    ["CR", "\r"],
    ["LF", "\n"],
    ["VT", "\v"],
    ["FF", "\f"],
    ["NEL", "\u0085"],
    ["U+1680", "\u1680"],
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
    ["bullet", "\u2022"],
    ["fullwidth tilde", "\uFF5E"],
    ["wave dash", "\u301C"],
    ["katakana middle dot", "\u30FB"],
    ["halfwidth katakana dot", "\uFF65"],
  ];
  const ALL_SEPS = [...OLD_SEPS, ...NEW_SEPS.map(([, s]) => s)];
  const us = (s: string) => `602${s}555${s}0143`;

  it.each(NEW_SEPS)("%s joins the groups of a US, Mexican and international number", (_n, s) => {
    expect(stripPii(`tel ${us(s)} ok`)).toBe("tel [phone] ok");
    expect(stripPii(`tel 55${s}1234${s}5678 ok`)).toBe("tel [phone] ok");
    expect(stripPii(`tel +52${s}55${s}1234${s}5678 ok`)).toBe("tel [phone] ok");
  });

  it("two phones glued by a digit are scrubbed for every separator", () => {
    for (const s of ALL_SEPS) {
      expect(nd(stripPii(`${us(s)}1${us(s)}`)), JSON.stringify(s)).toBe(0);
      expect(nd(stripPii(`${us(s)}\uFF16${us(s)}`)), JSON.stringify(s)).toBe(0);
      expect(nd(stripPii(`${us(s)}\u0666${us(s)}`)), JSON.stringify(s)).toBe(0);
    }
  });

  it("a separator run of any length joins the groups (the bound of 8 is gone)", () => {
    for (const n of [9, 20, 200, 5000]) {
      expect(stripPii(us(" ".repeat(n)))).toBe("[phone]");
      expect(stripPii(us("\t".repeat(n)))).toBe("[phone]");
      expect(stripPii(`55${"\u3000".repeat(n)}1234${"\u3000".repeat(n)}5678`)).toBe("[phone]");
      expect(stripPii(`+52${"\u200B".repeat(n)}55 1234 5678`)).toBe("[phone]");
    }
  });

  it.each([
    ["6 0 2 5 5 5 0 1 4 3", "[phone]"],
    ["tel 6 0 2 5 5 5 0 1 4 3 ok", "tel [phone] ok"],
    [[..."6025550143"].join("\u200B"), "[phone]"],
    [[..."6025550143"].join("-"), "[phone]"],
    [[..."6025550143"].join("\u3000"), "[phone]"],
    [[..."6025550143"].join(" \u200B "), "[phone]"],
    ["+5 2 5 5 1 2 3 4 5 6 7 8", "[phone]"],
    ["\uFF16 \uFF10 \uFF12 \uFF15 \uFF15 \uFF15 \uFF10 \uFF11 \uFF14 \uFF13", "[phone]"],
  ])("a separator between every digit: %s", (text, out) => {
    expect(stripPii(text)).toBe(out);
  });

  it("a run of 20 or more digits joined by separators is a phone pair, not a card", () => {
    expect(stripPii("602 555 0143 602 555 0143")).toBe("[phone]");
    expect(stripPii("602-555-0143-602-555-0143")).toBe("[phone]");
    expect(nd(stripPii("60255501431602555014312"))).toBe(0);
    expect(stripPii("tracking 9400100000000000000000 ok")).toBe("tracking [phone] ok");
  });

  it("a run under 20 digits keeps the old card rule", () => {
    expect(stripPii("card 4111 1111 1111 1111 ok")).toBe("card [number] ok");
    expect(stripPii("card 4111-1111-1111-1111 ok")).toBe("card [number] ok");
    expect(stripPii("card 4111111111111111 ok")).toBe("card [number] ok");
    expect(stripPii("card 411111111111 ok")).toBe("card 411111111111 ok");
  });

  it.each([
    ["comma", "602,555,0143", "[phone]"],
    ["colon", "602:555:0143", "[phone]"],
    ["US prefix with colons", "tel 1:602:555:0143", "tel [phone]"],
    ["Mexican comma", "55,1234,5678", "[phone]"],
    ["Mexican colon", "55:1234:5678", "[phone]"],
    ["Mexican colon inside a sentence", "llama 33:1234:5678 hoy", "llama [phone] hoy"],
  ])("%s joins only the national patterns: %s", (_n, text, out) => {
    expect(stripPii(text)).toBe(out);
  });

  it.each([
    "Sold 120, 340, 1200 units",
    "10:30, 11:45, 12:15",
    "UTC+05:30 2026-10-14",
    "+12,345,678 units",
    "1.234.567,89",
    "sizes 8.5 9.5 10.5 11.5 12.5 in",
    "192.168.0.1",
    "In stock: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10",
    "price 1,234,567 total",
    "at 10:30:45 ok",
    "Order 2026-10-14\n10:30 shipped",
    "1Z999AA10123456784123456",
  ])("keeps %j", (text) => {
    expect(stripPii(text)).toBe(text);
  });

  it("keeps the two remainders of the comma and colon rule (AC8): no 7-digit run is left", () => {
    expect(stripPii("602, 555, 0143")).toBe("602, 555, 0143");
    expect(stripPii("+44:20:7946:0958")).toBe("+44:20:7946:0958");
    expect(stripPii("+52,55,1234,5678")).not.toMatch(/\d{7}/);
  });

  it.each([
    ["Qty\n120\n340\n1200", "Qty\n[phone]"],
    ["5 4 5 5 3 4 5 5 4 5", "[phone]"],
    ["2026/10/14 2026/10/15 2026/10/16", "[phone]"],
    ["zip 85003 85004 85005 85006", "zip [phone]"],
  ])("scrubs the same class as the old number net: %j", (text, out) => {
    expect(stripPii(text)).toBe(out);
  });

  it("a date on the next line stays whole", () => {
    expect(stripPii("tel 602 555 0143\n2026-10-14")).toBe("tel [phone]\n2026-10-14");
  });

  it.each(["\r", "\n", "\v", "\f", "\u0085", "\u1680", "\u2028", "\u2029"])(
    "an international number followed by a date after %j keeps the date whole",
    (s) => {
      expect(stripPii(`+52 55 1234 5678${s}14/10/2026`)).toBe(`[phone]${s}14/10/2026`);
    },
  );

  it.each([
    "\t",
    "-",
    "\u00A0",
    "\u202F",
    ...Array.from({ length: 14 }, (_, i) => String.fromCharCode(0x2000 + i)),
    ...Array.from({ length: 6 }, (_, i) => String.fromCharCode(0x2010 + i)),
    "\u205F",
    "\u2060",
    "\u2212",
    "\u3000",
    "\uFEFF",
    "\uFF0D",
  ])("a card number written with the separator %j is a card", (s) => {
    expect(stripPii(`card ${["4111", "1111", "1111", "1111"].join(s)} ok`)).toBe(
      "card [number] ok",
    );
  });

  const mapDigits = (s: string, zero: number) =>
    s.replace(/[0-9]/g, (d) => String.fromCodePoint(zero + Number(d)));
  it.each([
    ["Arabic-Indic", 0x660],
    ["extended Arabic-Indic", 0x6f0],
    ["Devanagari", 0x966],
    ["mathematical bold", 0x1d7ce],
    ["fullwidth", 0xff10],
  ])("%s digits are digits", (_n, zero) => {
    expect(stripPii(mapDigits("602-555-0143", zero))).toBe("[phone]");
    expect(stripPii(`+${mapDigits("52 55 1234 5678", zero)}`)).toBe("[phone]");
    expect(stripPii(mapDigits("4111 1111 1111 1111", zero))).toBe("[number]");
  });

  it.each([
    ["Arabic-Indic", 0x660],
    ["extended Arabic-Indic", 0x6f0],
    ["Devanagari", 0x966],
    ["fullwidth", 0xff10],
  ])("a Mexican lada written in %s digits is a phone", (_n, zero) => {
    expect(stripPii(mapDigits("55 1234 5678", zero))).toBe("[phone]");
    expect(stripPii(mapDigits("(33) 1234 5678", zero))).toBe("[phone]");
    expect(stripPii(mapDigits("81-1234-5678", zero))).toBe("[phone]");
    expect(stripPii(mapDigits("56 1234 5678", zero))).toBe("[phone]");
  });

  it("a digit of another script glued before or after a number blocks nothing", () => {
    expect(stripPii("\u0661602-555-0143")).toBe("\u0661602-555-0143");
    expect(stripPii("602-555-0143\u0661")).toBe("602-555-0143\u0661");
  });

  it("fullwidth cards, ZIPs and street addresses use the ASCII placeholders", () => {
    const fw = (s: string) =>
      s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    expect(stripPii(fw("4111 1111 1111 1111"))).toBe("[number]");
    expect(stripPii(fw("4111-1111-1111-1111"))).toBe("[number]");
    expect(
      stripPii(
        "\uFF14\uFF11\uFF11\uFF11\u3000\uFF11\uFF11\uFF11\uFF11\u3000\uFF11\uFF11\uFF11\uFF11\u3000\uFF11\uFF11\uFF11\uFF11",
      ),
    ).toBe("[number]");
    expect(stripPii("zip 85003-1234 ok")).toBe("zip [zip] ok");
    expect(stripPii("zip \uFF18\uFF15\uFF10\uFF10\uFF13-\uFF11\uFF12\uFF13\uFF14 ok")).toBe(
      "zip [zip] ok",
    );
    expect(stripPii(`zip ${fw("85003-1234")} ok`)).toBe("zip [zip] ok");
    expect(stripPii("zip \u0668\u0665\u0660\u0660\u0663-\u0661\u0662\u0663\u0664 ok")).toBe(
      "zip [zip] ok",
    );
    expect(stripPii("zip 85003 ok")).toBe("zip 85003 ok");
    expect(stripPii("ship to 2140 E Camelback Rd.")).toBe("ship to [address]");
    expect(stripPii(`ship to ${fw("2140 E Camelback Rd")}`)).toBe("ship to [address]");
    expect(stripPii("ship to \uFF12\uFF11\uFF14\uFF10 E Camelback Rd")).toBe("ship to [address]");
    expect(stripPii(`ship to ${fw("2140")} E Camelback Rd Apt 4`)).toBe("ship to [address]");
    expect(stripPii(`ship to ${fw("12 Main St Suite 5")}`)).toBe("ship to [address]");
    expect(stripPii("ship to 2140\u3000East\u3000Camelback\u3000Road")).toBe("ship to [address]");
    expect(stripPii("2140 E Camelback Roadmap")).toBe("2140 E Camelback Roadmap");
    expect(stripPii(`${fw("2140 E Camelback Roadmap")}`)).toBe(fw("2140 E Camelback Roadmap"));
  });

  it.each([
    [`"${"a".repeat(300)}"@x.com`, "[email]"],
    [`"${"a".repeat(2000)}"@x.com`, "[email]"],
    [`mail "${"a b".repeat(700)}"@x.com now`, "mail [email] now"],
    ['"jo\nsmith"@x.com', "[email]"],
    ['"jo\r\nsmith"@x.com', "[email]"],
    ['mail "jo\nsmith"@x.com now', "mail [email] now"],
    ["jo@example.c\u200Bom", "[email]"],
    ["jo@x.co\u200Dm", "[email]"],
    ["jo@x.c\u200B\u200Bom", "[email]"],
    ["jo@x.com\u200B", "[email]"],
    [
      "\uFF4A\uFF4F\uFF0E\uFF53\uFF4D\uFF49\uFF54\uFF48\uFF20\uFF58\uFF0E\uFF43\uFF4F\uFF4D",
      "[email]",
    ],
    ["\uFF4A\uFF4F\uFF0E\uFF53\uFF4D\uFF49\uFF54\uFF48@x.com", "[email]"],
    ["\uFF4A\uFF4F\uFF0D\uFF53\uFF4D\uFF49\uFF54\uFF48\uFF20x.com", "[email]"],
    ["\uFF4A\uFF4F\uFF3F\uFF53\uFF4D\uFF49\uFF54\uFF48\uFF20x.com", "[email]"],
    ["\uFF4A\uFF4F\uFF0B\uFF53\uFF4D\uFF49\uFF54\uFF48\uFF20x.com", "[email]"],
    ["\uFF4A\uFF4F\uFF05\uFF53\uFF4D\uFF49\uFF54\uFF48\uFF20x.com", "[email]"],
    ["jo\u3002smith@x.com", "[email]"],
    ["jo\uFF61smith@x.com", "[email]"],
  ])("email form %j -> %j", (text, out) => {
    expect(stripPii(text)).toBe(out);
  });

  it("an escaped quote still does not open a quoted local part, at any distance", () => {
    expect(stripPii(`${'\\"'.repeat(1000)}a b"@x.com`)).not.toContain("[email]a");
    expect(stripPii('"a\\\\"b"@x.com')).toBe('"a\\\\[email]');
    expect(stripPii('"jo\\"s"@x.com')).toBe("[email]");
    expect(stripPii('"jo\\\\\\"s"@x.com')).toBe("[email]");
  });

  it("an opener before the previous email is not reused", () => {
    expect(stripPii('x "q"@b.cc and r"@d.ee')).toBe('x [email] and r"@d.ee');
  });

  it.each([
    [`"${"a".repeat(300)}"@x.com."${"b".repeat(300)}"@y.com`, "[email][email]"],
    [`"${"a".repeat(300)}"@x.com "${"b".repeat(300)}"@y.com`, "[email] [email]"],
    ['"jo\nsmith"@x.com "ab\ncd"@y.com', "[email] [email]"],
    ['"jo\nsmith"@x.com."ab\ncd"@y.com', "[email][email]"],
    ['"jo\nsmith"@x.com-"ab\ncd"@y.com', "[email][email]"],
    ["jo@x.c\u200Bom-ana@y.c\u200Bom", "[email][email]"],
    ["jo@x.c\u200Bom7ana@y.c\u200Bom", "[email][email]"],
    ["jo@x.c\u200Bom ana@y.c\u200Bom", "[email] [email]"],
    ["jo@x.c\u200Bom.ana@y.c\u200Bom", "[email]"],
    ["\uFF4A\uFF0E\uFF53\uFF20x.com.\uFF41\uFF0E\uFF42\uFF20y.com", "[email][email]"],
    ["\uFF4A\uFF0E\uFF53\uFF20x.com \uFF41\uFF0E\uFF42\uFF20y.com", "[email] [email]"],
    ["\uFF4A\uFF0E\uFF53\uFF20x.com-\uFF41\uFF0E\uFF42\uFF20y.com", "[email][email]"],
    ["\uFF4A\uFF0E\uFF53\uFF20x.com7\uFF41\uFF0E\uFF42\uFF20y.com", "[email][email]"],
  ])("glued: %j -> %j", (text, out) => {
    expect(stripPii(text)).toBe(out);
  });
});

describe("stripPiiDeep with the T-55-1 forms", () => {
  it("scrubs a new phone form and a new email form in nested values and arrays", () => {
    const out = stripPiiDeep({
      a: { b: ["ring 602\n555\n0143 ok", { c: "mail \uFF4A\uFF0E\uFF53\uFF20x.com" }] },
      d: [["tel 6 0 2 5 5 5 0 1 4 3", "call 602,555,0143 now"], `"${"a b".repeat(200)}"@x.com`],
      e: [
        { f: "\u0666\u0660\u0662-\u0665\u0665\u0665-\u0660\u0661\u0664\u0663" },
        "jo@x.c\u200Bom",
      ],
    });
    expect(out).toEqual({
      a: { b: ["ring [phone] ok", { c: "mail [email]" }] },
      d: [["tel [phone]", "call [phone] now"], "[email]"],
      e: [{ f: "[phone]" }, "[email]"],
    });
  });
});

describe("stripPii stays linear on the T-55-1 shapes", () => {
  const BOUND_MS = 1000;
  const KB200 = 200_000;
  const NEW_SEP_CHARS = [
    "\r",
    "\n",
    "\v",
    "\f",
    "\u0085",
    "\u1680",
    "\u2028",
    "\u2029",
    "\u2022",
    "\uFF5E",
    "\u301C",
    "\u30FB",
    "\uFF65",
  ];
  const sepShapes: [string, string][] = NEW_SEP_CHARS.flatMap((s) => {
    const label = `U+${s.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    return [
      [`602 ${label} run then 555`, `602${s.repeat(KB200)}555`],
      [`+ then 1 and ${label}`, `+${`1${s}`.repeat(100_000)}`],
      [`1 and ${label} without a plus`, `1${s}`.repeat(100_000)],
      [`12 and ${label} pairs`, `12${s}${s}`.repeat(60_000)],
    ];
  });
  const mapZero = (s: string, zero: number) =>
    s.replace(/[0-9]/g, (d) => String.fromCodePoint(zero + Number(d)));
  const shapes: [string, string][] = [
    ...sepShapes,
    ["spaced digits", "1 ".repeat(100_000)],
    ["spaced digits in pairs", "12 ".repeat(66_000)],
    ["spaced digits with a plus", `+${"1 ".repeat(100_000)}`],
    ["spaced digits, zero-width", "1\u200B".repeat(100_000)],
    ["spaced digits, hyphen", "1-".repeat(100_000)],
    ["spaced digits, fullwidth", "\uFF11\u3000".repeat(66_000)],
    ["a 200k digit run", "1".repeat(KB200)],
    ["a 32 digit run then a letter", `${"1".repeat(32)}a`],
    ["a 200k digit run then a letter", `${"1".repeat(KB200)}a`],
    ["spaced digits then a letter", `${"1 ".repeat(100_000)}a`],
    ["hyphenated digits then a letter", `${"1-".repeat(100_000)}a`],
    ["a 200k Arabic-Indic digit run", "\u0661".repeat(KB200)],
    ["Arabic-Indic digits and spaces", "\u0661\u0662\u0663 ".repeat(50_000)],
    ["Arabic-Indic plus run", `+${"\u0661 ".repeat(100_000)}`],
    ["Arabic-Indic lada groups", mapZero("55 1234 ", 0x660).repeat(25_000)],
    ["mathematical digits", "\u{1D7CF}".repeat(100_000)],
    ["mathematical digits spaced", "\u{1D7CF} ".repeat(60_000)],
    ["comma runs", "1,".repeat(100_000)],
    ["colon runs", "55:".repeat(66_000)],
    ["comma 3-3-4 groups", "123,456,7890,".repeat(15_000)],
    ["colon 2-4-4 groups", "55:1234:5678:".repeat(15_000)],
    ["US groups with LF", "123\n456\n7890\n".repeat(15_000)],
    ["a comma run between groups", `602${",".repeat(KB200)}555`],
    ["a colon run between groups", `55${":".repeat(KB200)}1234`],
    ["many zero-width between digits", `${"1\u200B\u200B".repeat(66_000)}`],
    ["a 20 digit near miss repeated", "1234567890123456789 ".repeat(10_000)],
    ["a 12 digit near miss repeated", "1 2 3 4 5 6 7 8 9 ".repeat(11_000)],
    ["a 10 digit single run repeated", "1 2 3 4 5 6 7 8 9 0 x".repeat(9_000)],
    ["a 13 digit card net repeated", "4111 1111 1111 1 x".repeat(11_000)],
    ["dates joined by slashes", "2026/10/14 ".repeat(18_000)],
    ["fullwidth card groups", "\uFF11\uFF11\uFF11\uFF11\u3000".repeat(40_000)],
    ["fullwidth zip dash", "\uFF18\uFF15\uFF10\uFF10\uFF13\uFF0D\uFF11\uFF12\uFF13".repeat(20_000)],
    ["fullwidth address words", `12\u3000${"\uFF21\uFF42 ".repeat(66_000)}`],
    ["address words long", `12 ${"Ab ".repeat(66_000)}`],
    ["address numbers", "12 Ab Cd ".repeat(22_000)],
    ["address unit", `12 Ab St ${"Apt ".repeat(40_000)}`],
    ["quoted local across LF, one @", `"${"a\n".repeat(100_000)}"@x.com`],
    ["quoted opener LF pairs repeated", '"a\nb"@c.dd '.repeat(18_000)],
    ["opener far before many @", `"${"a b ".repeat(20_000)}${"c@d.ee ".repeat(18_000)}`],
    ["escaped quotes across LF then @", '\\"\n@b.cc '.repeat(25_000)],
    ["quote escapes then @ repeated", '"\\"@b.cc '.repeat(25_000)],
    ["1 MB escaped quote, no opener", '\\"@b.cc '.repeat(125_000)],
    ["1 MB quoted, quote then @ repeated", '"@b.cc '.repeat(140_000)],
    ["zero-width TLD letters", `jo@x.${"c\u200B".repeat(100_000)}`],
    ["zero-width TLD and @ repeated", "a@b.c\u200Bd ".repeat(25_000)],
    ["zero-width TLD then more domain", `a@b.${"c\u200B".repeat(50_000)}-`],
    ["fullwidth local run before one @", `${"\uFF4A\uFF0E".repeat(100_000)}@x.com`],
    ["fullwidth local run, fullwidth @", `${"\uFF4A\uFF0D".repeat(100_000)}\uFF20x.com`],
    ["fullwidth local with punctuation", `${"\uFF3F\uFF0B\uFF05".repeat(66_000)}@x.com`],
    ["ideographic stops before one @", `${"\u3002".repeat(KB200)}@x.com`],
    ["fullwidth local and @ repeated", "\uFF4A\uFF0E\uFF53\uFF20b.cc ".repeat(20_000)],
  ];
  it.each(shapes)("%s", (_name, text) => {
    const t0 = performance.now();
    stripPii(text);
    expect(performance.now() - t0).toBeLessThan(BOUND_MS);
  });

  it("a realistic 200 KB listing text is unchanged and fast", () => {
    const para =
      "Vintage desert bloom tee, soft ring-spun cotton, 12 x 16 in DTF transfer, sizes S-3XL. Order #1042 ships in 2-3 days; $19.99, 2026-10-14 10:30. Care: wash cold 30\u00B0C, tumble dry low. Bulk 10+ pcs save 6.5%. SKU TEE-BLK-XL / G500-BLK-2XL.\n";
    const text = para.repeat(Math.ceil(KB200 / para.length)).slice(0, KB200);
    const t0 = performance.now();
    const out = stripPii(text);
    expect(performance.now() - t0).toBeLessThan(BOUND_MS);
    expect(out).toBe(text);
  });
});
