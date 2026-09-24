import { describe, expect, it } from "vitest";
import { mockRates, mockTrackingCode, mockZone } from "../../integrations/carriers/mock";
import { choosePreset, parcelWeight, pickRate } from "./service";

const addr = (zip: string) => ({
  name: "A",
  company: null,
  street1: "1 Main St",
  street2: null,
  city: "X",
  state: "AZ",
  zip,
  country: "US",
  phone: null,
  email: null,
});

describe("mock carrier", () => {
  it("prices by weight and zone, deterministically", () => {
    expect(mockZone("85016", "85004")).toBe(1);
    expect(mockZone("85016", "10001")).toBe(8);
    const req = (oz: number, to: string) => ({
      shipmentId: "3f0f6f1e-0000-4000-8000-000000000000",
      from: addr("85016"),
      to: addr(to),
      parcel: { lengthIn: 10, widthIn: 13, heightIn: 1, weightOz: oz },
    });
    const now = new Date("2026-09-24T00:00:00Z");
    const a = mockRates(req(6, "10001"), now);
    expect(mockRates(req(6, "10001"), now)).toEqual(a);
    expect(a.map((r) => r.service)).toEqual(["GroundAdvantage", "Priority", "Ground"]);
    const heavier = mockRates(req(30, "10001"), now);
    const nearer = mockRates(req(6, "85004"), now);
    for (const [i, r] of a.entries()) {
      expect(heavier[i]?.rateCents).toBeGreaterThan(r.rateCents);
      expect(nearer[i]?.rateCents).toBeLessThan(r.rateCents);
    }
    expect(mockTrackingCode("usps", "s1")).toMatch(/^9400\d{18}$/);
    expect(mockTrackingCode("ups", "s1")).toMatch(/^1ZMOCK\d{12}$/);
  });
});

describe("rate picking and parcels", () => {
  const rates = [
    {
      rateId: "ga",
      carrier: "usps" as const,
      service: "GroundAdvantage",
      serviceLabel: "",
      rate: 500,
      deliveryDays: 5,
      estimatedDeliveryAt: null,
      cheapest: true,
      fastest: false,
    },
    {
      rateId: "pm",
      carrier: "usps" as const,
      service: "Priority",
      serviceLabel: "",
      rate: 900,
      deliveryDays: 2,
      estimatedDeliveryAt: null,
      cheapest: false,
      fastest: true,
    },
    {
      rateId: "ug",
      carrier: "ups" as const,
      service: "Ground",
      serviceLabel: "",
      rate: 800,
      deliveryDays: 3,
      estimatedDeliveryAt: null,
      cheapest: false,
      fastest: false,
    },
  ];
  const now = new Date("2026-09-24T12:00:00Z");

  it("picks cheapest, fastest, or the cheapest that arrives in time", () => {
    expect(pickRate(rates, "cheapest", now, now)?.rateId).toBe("ga");
    expect(pickRate(rates, "fastest", now, now)?.rateId).toBe("pm");
    // Due today: must arrive within 3 days -> UPS Ground beats Priority on price.
    expect(pickRate(rates, "cheapest_on_time", now, now)?.rateId).toBe("ug");
    // Plenty of slack: the cheapest service is on time.
    expect(pickRate(rates, "cheapest_on_time", new Date("2026-09-27T12:00:00Z"), now)?.rateId).toBe(
      "ga",
    );
    expect(pickRate([], "cheapest", now, now)).toBeNull();
  });

  it("weighs garments with style overrides plus tare, and fits a preset", () => {
    const blanks = [
      { styleCode: "64000", weightOz: 5.3 },
      { styleCode: "1717", weightOz: 6.1 },
    ];
    expect(parcelWeight(blanks, [], 0.5)).toBe(11.9);
    expect(parcelWeight(blanks, [{ styleCode: "1717", weightOz: 7 }], 0.5)).toBe(12.8);
    const preset = (id: string, maxUnits: number | null, isDefault = false) =>
      ({ id, maxUnits, isDefault }) as Parameters<typeof choosePreset>[0][number];
    const presets = [preset("mailer", 3, true), preset("box", 10), preset("big", null)];
    expect(choosePreset(presets, 2)?.id).toBe("mailer");
    expect(choosePreset(presets, 4)?.id).toBe("box");
    expect(choosePreset(presets, 40)?.id).toBe("big");
  });
});
