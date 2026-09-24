import { describe, expect, it } from "vitest";
import { addBusinessDays, computeShipBy } from "./shipby";

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
});
