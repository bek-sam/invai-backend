import { afterEach, describe, expect, it } from "vitest";
import { PRICE_CHANGES } from "../rate-ttl";
import { mockRates } from "./index";
import { USPS_PEAK_SURCHARGE } from "./peak-surcharge";

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

/** Zone k = ZIP prefix distance (k-1) * 100 from "000". */
const zipForZone = (zone: number) => `${String((zone - 1) * 100).padStart(3, "0")}01`;
const ZONES = [1, 2, 3, 4, 5, 6, 7, 8];
const rates = (oz: number, zone: number, now: Date) =>
  mockRates(
    {
      shipmentId: "3f0f6f1e-0000-4000-8000-000000000000",
      from: addr("00001"),
      to: addr(zipForZone(zone)),
      parcel: { lengthIn: 10, widthIn: 13, heightIn: 1, weightOz: oz },
    },
    now,
  );

const BASE_DAY = new Date("2026-09-24T12:00:00Z");
const INSIDE = new Date("2026-11-15T12:00:00Z");
const USPS = ["GroundAdvantage", "Priority"];
const byService = (r: ReturnType<typeof rates>, service: string) => {
  const found = r.find((x) => x.service === service);
  if (!found) throw new Error(`no ${service}`);
  return found;
};

afterEach(() => {
  USPS_PEAK_SURCHARGE.enabled = true;
});

describe("USPS peak surcharge in the mock carrier", () => {
  it("adds the weight tier to Ground Advantage and Priority at every zone, inside the window", () => {
    const cases: [number, number][] = [
      [6, 40],
      [15.99, 40],
      [16, 40],
      [48, 40],
      [49, 65],
      [160, 65],
      [161, 105],
      [400, 105],
      [416, 0],
      [1120, 0],
    ];
    for (const [oz, add] of cases) {
      for (const zone of ZONES) {
        const base = rates(oz, zone, BASE_DAY);
        const peak = rates(oz, zone, INSIDE);
        for (const service of USPS) {
          expect(
            byService(peak, service).rateCents - byService(base, service).rateCents,
            `${service} ${oz} oz zone ${zone}`,
          ).toBe(add);
        }
      }
    }
  });

  it("matches a hand-computed price (Ground Advantage, 6 oz, zone 1)", () => {
    // base 400 + ceil(6/4) * 35 + 1 * 28 = 498; plus 40
    expect(byService(rates(6, 1, BASE_DAY), "GroundAdvantage").rateCents).toBe(498);
    expect(byService(rates(6, 1, INSIDE), "GroundAdvantage").rateCents).toBe(538);
  });

  it("changes only the price: rateId and estimatedDeliveryAt follow the base quote", () => {
    const strip = (r: ReturnType<typeof rates>) =>
      r.map(({ rateCents: _c, estimatedDeliveryAt: _e, ...rest }) => rest);
    expect(strip(rates(30, 3, INSIDE))).toEqual(strip(rates(30, 3, BASE_DAY)));
    for (const r of rates(30, 3, INSIDE)) {
      expect(Date.parse(r.estimatedDeliveryAt ?? "") - INSIDE.getTime()).toBe(
        (r.deliveryDays ?? 0) * 86400_000,
      );
    }
  });

  it("switches at the four Central-midnight instants", () => {
    const price = (iso: string) =>
      byService(rates(6, 2, new Date(iso)), "GroundAdvantage").rateCents;
    const base = price("2026-09-24T12:00:00.000Z");
    expect(price("2026-10-04T04:59:59.999Z")).toBe(base);
    expect(price("2026-10-04T05:00:00.000Z")).toBe(base + 40);
    expect(price("2027-01-18T05:59:59.999Z")).toBe(base + 40);
    expect(price("2027-01-18T06:00:00.000Z")).toBe(base);
    const pri = (iso: string) => byService(rates(6, 2, new Date(iso)), "Priority").rateCents;
    expect(pri("2026-10-04T05:00:00.000Z") - pri("2026-10-04T04:59:59.999Z")).toBe(40);
    expect(pri("2027-01-18T05:59:59.999Z") - pri("2027-01-18T06:00:00.000Z")).toBe(40);
  });

  it("never changes UPS", () => {
    for (const oz of [6, 49, 200, 400]) {
      for (const zone of ZONES) {
        const base = byService(rates(oz, zone, BASE_DAY), "Ground").rateCents;
        for (const iso of [
          "2026-10-04T05:00:00.000Z",
          "2026-11-15T12:00:00Z",
          "2027-01-18T05:59:59.999Z",
        ]) {
          expect(byService(rates(oz, zone, new Date(iso)), "Ground").rateCents).toBe(base);
        }
      }
    }
  });

  it("keeps price non-decreasing in weight and zone, and rising from 25 to 26 lb", () => {
    for (const now of [INSIDE, BASE_DAY]) {
      for (const service of [...USPS, "Ground"]) {
        for (const zone of ZONES) {
          let prev = 0;
          for (let oz = 1; oz <= 1120; oz++) {
            const cents = byService(rates(oz, zone, now), service).rateCents;
            expect(cents, `${service} z${zone} ${oz} oz`).toBeGreaterThanOrEqual(prev);
            prev = cents;
          }
          expect(byService(rates(416, zone, now), service).rateCents).toBeGreaterThan(
            byService(rates(400, zone, now), service).rateCents,
          );
        }
        for (const oz of [6, 49, 400, 1120]) {
          let prev = 0;
          for (const zone of ZONES) {
            const cents = byService(rates(oz, zone, now), service).rateCents;
            expect(cents).toBeGreaterThanOrEqual(prev);
            prev = cents;
          }
        }
      }
    }
  });

  it("is off at any clock when the PRC switch is false", () => {
    USPS_PEAK_SURCHARGE.enabled = false;
    for (const oz of [6, 49, 200]) {
      for (const service of USPS) {
        expect(byService(rates(oz, 3, INSIDE), service).rateCents).toBe(
          byService(rates(oz, 3, BASE_DAY), service).rateCents,
        );
      }
    }
  });

  it("is a labeled table whose window equals the USPS price-change instants", () => {
    expect(USPS_PEAK_SURCHARGE.status).toBe("pending PRC review");
    expect(USPS_PEAK_SURCHARGE.sources).toEqual(
      expect.arrayContaining([
        "https://www.supplychaindive.com/news/usps-announces-6-rate-increase-for-2026-peak-season/828763/",
        "https://dclcorp.com/blog/shipping/2026-usps-holiday-peak-surcharge/",
      ]),
    );
    expect(USPS_PEAK_SURCHARGE.startsAt).toBe("2026-10-04T05:00:00.000Z");
    expect(USPS_PEAK_SURCHARGE.endsBefore).toBe("2027-01-18T06:00:00.000Z");
    const usps = PRICE_CHANGES.filter((c) => c.carrier === "usps").map((c) => c.at);
    expect(usps).toContain(USPS_PEAK_SURCHARGE.startsAt);
    expect(usps).toContain(USPS_PEAK_SURCHARGE.endsBefore);
  });
});
