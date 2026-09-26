import { describe, expect, it } from "vitest";
import { addBusinessDays, computeShipBy, USPS_HOLIDAYS } from "./shipby";

describe("ship-by", () => {
  const tz = "America/Phoenix";
  it("adds business days and ends at the shop's end of day", () => {
    // Tue 2026-09-22 10:00 Phoenix + 2 business days = Thu 23:59:59.999 Phoenix.
    expect(addBusinessDays(new Date("2026-09-22T17:00:00Z"), 2, tz).toISOString()).toBe(
      "2026-09-25T06:59:59.999Z",
    );
    // Fri + 1 skips the weekend to Monday.
    expect(addBusinessDays(new Date("2026-09-25T17:00:00Z"), 1, tz).toISOString()).toBe(
      "2026-09-29T06:59:59.999Z",
    );
    // Placed on Saturday with 0 days: due Monday.
    expect(addBusinessDays(new Date("2026-09-26T17:00:00Z"), 0, tz).toISOString()).toBe(
      "2026-09-29T06:59:59.999Z",
    );
  });

  it("uses channel defaults, connection processing days and date-only channel ship-bys", () => {
    const placedAt = new Date("2026-09-22T17:00:00Z");
    const base = { placedAt, channelShipBy: null, timeZone: tz };
    // Etsy default 3 days, Shopify default 2, override 5.
    expect(computeShipBy({ ...base, channel: "etsy", processingDays: null }).toISOString()).toBe(
      "2026-09-26T06:59:59.999Z",
    );
    expect(computeShipBy({ ...base, channel: "shopify", processingDays: null }).toISOString()).toBe(
      "2026-09-25T06:59:59.999Z",
    );
    expect(computeShipBy({ ...base, channel: "shopify", processingDays: 5 }).toISOString()).toBe(
      "2026-09-30T06:59:59.999Z",
    );
    const exact = new Date("2026-09-23T06:59:59Z");
    expect(
      computeShipBy({ ...base, channel: "amazon", channelShipBy: exact, processingDays: null }),
    ).toBe(exact);
    const dateOnly = new Date("2026-09-23T12:00:00.000Z");
    expect(
      computeShipBy({
        ...base,
        channel: "walmart",
        channelShipBy: dateOnly,
        processingDays: null,
      }).toISOString(),
    ).toBe("2026-09-24T06:59:59.999Z");
  });

  it("skips USPS postal holidays (B-26)", () => {
    // Wed 11/25/2026 + 1: Thu 11/26 is Thanksgiving -> Fri 11/27.
    expect(addBusinessDays(new Date("2026-11-25T17:00:00Z"), 1, tz).toISOString()).toBe(
      "2026-11-28T06:59:59.999Z",
    );
    // Thu 12/24/2026 + 1: Fri 12/25 Christmas, weekend -> Mon 12/28.
    expect(addBusinessDays(new Date("2026-12-24T17:00:00Z"), 1, tz).toISOString()).toBe(
      "2026-12-29T06:59:59.999Z",
    );
    // Placed on a holiday (Mon 1/19/2026, MLK Day) with 0 days: due Tue.
    expect(addBusinessDays(new Date("2026-01-19T17:00:00Z"), 0, tz).toISOString()).toBe(
      "2026-01-21T06:59:59.999Z",
    );
    // Sun 7/4/2027 is observed Mon 7/5: Fri 7/2 + 1 -> Tue 7/6.
    expect(addBusinessDays(new Date("2027-07-02T17:00:00Z"), 1, tz).toISOString()).toBe(
      "2027-07-07T06:59:59.999Z",
    );
    expect(USPS_HOLIDAYS.size).toBe(22);
  });

  it("ships Saturdays when the shop does, except a Saturday holiday", () => {
    // Fri 9/25/2026 + 1 with Saturday shipping: Sat 9/26.
    expect(
      addBusinessDays(new Date("2026-09-25T17:00:00Z"), 1, tz, {
        shipsSaturday: true,
      }).toISOString(),
    ).toBe("2026-09-27T06:59:59.999Z");
    // Fri 7/3/2026 + 1: Sat 7/4 is Independence Day (post offices closed) -> Mon 7/6.
    expect(
      addBusinessDays(new Date("2026-07-03T17:00:00Z"), 1, tz, {
        shipsSaturday: true,
      }).toISOString(),
    ).toBe("2026-07-07T06:59:59.999Z");
  });

  it("respects the Etsy CSV processing time across a holiday", () => {
    // Etsy CSV has no ship-by column: the connection's processing days (5) from Mon 11/23/2026:
    // Tue, Wed, (Thanksgiving), Fri, Mon, Tue 12/1.
    expect(
      computeShipBy({
        channel: "etsy",
        placedAt: new Date("2026-11-23T17:00:00Z"),
        channelShipBy: null,
        processingDays: 5,
        timeZone: tz,
      }).toISOString(),
    ).toBe("2026-12-02T06:59:59.999Z");
  });
});
