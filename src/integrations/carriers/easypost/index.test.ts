import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarrierError } from "../types";
import { createEasypostCarrier, createEasypostTracking, easypostError, RETRY_429 } from "./index";

/*
 * EasyPost adapter against a stubbed fetch: error mapping (only rate codes that mean "fetch new
 * rates" are `rate_expired`; 429 is never `rate_expired`), 429 backoff on safe requests only,
 * unsupported carriers named instead of dropped silently, and the tracker read for the poll.
 */

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let replies: Array<() => Response>;

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  replies = [];
  RETRY_429.baseMs = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = replies.shift();
      if (!next) throw new Error(`unexpected fetch ${url}`);
      return next();
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  RETRY_429.baseMs = 500;
});

const address = {
  name: "A",
  company: null,
  street1: "1 Main St",
  street2: null,
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  country: "US",
  phone: null,
  email: null,
};
const rateReq = {
  companyId: "00000000-0000-4000-8000-000000000001",
  shipmentId: "00000000-0000-4000-8000-000000000002",
  from: address,
  to: address,
  parcel: { lengthIn: 10, widthIn: 8, heightIn: 1, weightOz: 6 },
};
const epRate = (id: string, carrier: string, service: string, rate: string) => ({
  id,
  carrier,
  service,
  rate,
  delivery_days: 3,
  delivery_date: null,
});

describe("easypostError", () => {
  it("maps only rate codes that mean 'fetch new rates' to rate_expired", () => {
    expect(easypostError(422, "SHIPMENT.RATE.CARRIER_ACCOUNT_INVALID", "m").code).toBe(
      "rate_expired",
    );
    expect(easypostError(422, "SHIPMENT.RATE.EXPIRED", "m").code).toBe("rate_expired");
    expect(easypostError(422, "ORDER.RATE.UNAVAILABLE", "m").code).toBe("rate_expired");
    // Before: anything containing "RATE" became rate_expired.
    expect(easypostError(429, "RATE_LIMITED", "slow down").code).toBe("upstream");
    expect(easypostError(422, "SHIPMENT.RATES.UNAVAILABLE", "m").code).toBe("upstream");
    expect(easypostError(422, "SHIPMENT.RATE.STAMP_UNAVAILABLE", "m").code).toBe("upstream");
  });

  it("429 is a clear refusal with a plain message; postage timeouts are unknown", () => {
    const limited = easypostError(429, "RATE_LIMITED", "x");
    expect(limited.outcome).toBe("not_done");
    expect(limited.message).toMatch(/Try again in a minute/);
    expect(easypostError(422, "ADDRESS.VERIFY.FAILURE", "bad").code).toBe("address_invalid");
    expect(easypostError(422, "SHIPMENT.POSTAGE.TIMED_OUT", "t").outcome).toBe("unknown");
    expect(easypostError(422, "SHIPMENT.POSTAGE.NO_RESPONSE", "t").outcome).toBe("unknown");
    expect(easypostError(422, "SHIPMENT.POSTAGE.EXISTS", "t").outcome).toBe("unknown");
    expect(easypostError(503, "INTERNAL", "t").outcome).toBe("unknown");
    expect(easypostError(422, "SHIPMENT.POSTAGE.FAILURE", "t").outcome).toBe("not_done");
  });
});

describe("EasyPost adapter over fetch", () => {
  const carrier = createEasypostCarrier("EZTKtest");
  const tracking = createEasypostTracking("EZTKtest");

  it("retries a 429 on rating with backoff, then returns rates", async () => {
    replies.push(
      json(429, { error: { code: "RATE_LIMITED", message: "slow" } }),
      json(201, { id: "shp_1", rates: [epRate("rate_1", "USPS", "GroundAdvantage", "4.50")] }),
    );
    const res = await carrier.rate(rateReq);
    expect(calls).toHaveLength(2);
    expect(res.rates).toEqual([expect.objectContaining({ rateId: "rate_1", rateCents: 450 })]);
  });

  it("never re-sends a buy on 429: one call, a clear refusal, not rate_expired", async () => {
    replies.push(json(429, { error: { code: "RATE_LIMITED", message: "slow" } }));
    const err = await carrier
      .buy({
        ...rateReq,
        carrierShipmentId: "shp_1",
        rate: {
          rateId: "rate_1",
          carrier: "usps",
          service: "GroundAdvantage",
          serviceLabel: "USPS Ground Advantage",
          rateCents: 450,
          deliveryDays: 3,
          estimatedDeliveryAt: null,
        },
      })
      .catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(CarrierError);
    expect(err).toMatchObject({ code: "upstream", outcome: "not_done" });
  });

  it("gives up on a read after the 429 retries, without hot-looping", async () => {
    for (let i = 0; i <= RETRY_429.attempts; i++)
      replies.push(json(429, { error: { code: "RATE_LIMITED", message: "slow" } }));
    const err = await carrier
      .lookup({ companyId: rateReq.companyId, shipmentId: "s", carrierShipmentId: "shp_1" })
      .catch((e) => e);
    expect(calls).toHaveLength(RETRY_429.attempts + 1);
    expect(err).toMatchObject({ code: "upstream", outcome: "not_done" });
  });

  it("names carriers it can't label instead of dropping them silently", async () => {
    replies.push(
      json(201, {
        id: "shp_2",
        rates: [
          epRate("r_usps", "USPS", "Priority", "9.10"),
          epRate("r_fedex", "FedEx", "FEDEX_GROUND", "8.00"),
        ],
      }),
      json(201, { id: "shp_3", rates: [epRate("r_fedex2", "FedEx", "FEDEX_GROUND", "8.00")] }),
    );
    const ok = await carrier.rate(rateReq);
    expect(ok.rates.map((r) => r.rateId)).toEqual(["r_usps"]);
    await expect(carrier.rate(rateReq)).rejects.toThrow(/FedEx, not supported yet/);
  });

  it("reads the tracker EasyPost made at purchase", async () => {
    replies.push(
      json(200, { id: "shp_9", tracking_code: "9400A", tracker: { id: "trk_9" } }),
      json(200, {
        id: "trk_9",
        object: "Tracker",
        tracking_code: "9400A",
        status: "out_for_delivery",
        shipment_id: "shp_9",
        tracking_details: [{ status: "in_transit", datetime: "2026-09-20T10:00:00Z" }],
      }),
    );
    const t = await tracking.track({
      companyId: rateReq.companyId,
      carrierShipmentId: "shp_9",
      trackingCode: "9400A",
      carrier: "usps",
    });
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^.*\/v2/, "")}`)).toEqual([
      "GET /shipments/shp_9",
      "GET /trackers/trk_9",
    ]);
    expect(t).toMatchObject({ trackerId: "trk_9", status: "out_for_delivery" });
  });

  it("creates the tracker when the shipment has none (EasyPost returns an existing one)", async () => {
    replies.push(
      json(200, { id: "shp_8", tracking_code: "9400B", tracker: null }),
      json(201, {
        id: "trk_8",
        object: "Tracker",
        tracking_code: "9400B",
        status: "pre_transit",
        shipment_id: null,
        tracking_details: [],
      }),
    );
    const t = await tracking.track({
      companyId: rateReq.companyId,
      carrierShipmentId: "shp_8",
      trackingCode: "9400B",
      carrier: "usps",
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      body: { tracker: { tracking_code: "9400B", carrier: "USPS" } },
    });
    expect(t).toMatchObject({ trackerId: "trk_8", carrierShipmentId: "shp_8" });
  });
});
