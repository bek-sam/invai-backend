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
    [`"${"a".repeat(255)}"@x.com`, `"${"a".repeat(255)}"@x.com`],
  ])("%s -> %s", (text, out) => {
    expect(stripPii(text)).toBe(out);
  });

  it("an @ inside a quoted local part no longer stops the scan (pin for the removed stop)", () => {
    expect(stripPii('mail "jo@smith"@x.com now')).toBe("mail [email] now");
  });

  it("a newline still stops the quoted scan", () => {
    expect(stripPii('"jo\nsmith"@x.com')).toBe('"jo\nsmith"@x.com');
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
