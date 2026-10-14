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

  it("a plus after a word character or another plus is not a phone start", () => {
    expect(stripPii("a+16025550143")).toBe("a+16025550143");
    expect(stripPii("++16025550143")).toBe("++16025550143");
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
  ];
  it.each(shapes)("200 KB: %s", (_name, text) => {
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
