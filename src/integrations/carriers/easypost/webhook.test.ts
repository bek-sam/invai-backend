import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  acceptedEventMode,
  MOCK_EASYPOST_WEBHOOK_SECRET,
  parseEasypostEvent,
  signEasypostBody,
  verifyEasypostSignature,
} from "./webhook";

/*
 * EasyPost's own webhook test vector (EasyPost/examples official/fixtures: event-body.json and
 * client-library-fixtures.json `webhooks`), the one easypost-node and easypost-python test
 * `validateWebhook` against. The secret "sécret" only matches after NFKD normalization.
 */
const officialBody = JSON.stringify(
  JSON.parse(readFileSync(new URL("./fixtures/official-event-body.json", import.meta.url), "utf8")),
);
const OFFICIAL_SECRET = "sécret";
const OFFICIAL_SIGNATURE =
  "hmac-sha256-hex=38f3f53c103713df81616a0a186d77141957323ec21d5fe9363db93840f527db";

describe("EasyPost webhook signature", () => {
  it("matches EasyPost's official test vector (NFKD-normalized secret)", () => {
    expect(signEasypostBody(officialBody, OFFICIAL_SECRET)).toBe(OFFICIAL_SIGNATURE);
    expect(
      verifyEasypostSignature({ "x-hmac-signature": OFFICIAL_SIGNATURE }, officialBody, "sécret"),
    ).toBe(true);
    // The header name is case-insensitive, as Node lowercases it and clients send X-Hmac-Signature.
    expect(
      verifyEasypostSignature({ "X-Hmac-Signature": OFFICIAL_SIGNATURE }, officialBody, "sécret"),
    ).toBe(true);
  });

  it("normalization matters: the same secret un-normalized gives another signature", () => {
    const plain = createHmac("sha256", OFFICIAL_SECRET.normalize("NFC"))
      .update(officialBody, "utf8")
      .digest("hex");
    expect(`hmac-sha256-hex=${plain}`).not.toBe(OFFICIAL_SIGNATURE);
    expect(signEasypostBody(officialBody, OFFICIAL_SECRET.normalize("NFC"))).toBe(
      OFFICIAL_SIGNATURE,
    );
  });

  it("rejects a changed body, a wrong secret, a missing header and a bad format", () => {
    const sig = { "x-hmac-signature": OFFICIAL_SIGNATURE };
    expect(verifyEasypostSignature(sig, `${officialBody} `, OFFICIAL_SECRET)).toBe(false);
    expect(verifyEasypostSignature(sig, officialBody, "invalid_secret")).toBe(false);
    expect(verifyEasypostSignature({}, officialBody, OFFICIAL_SECRET)).toBe(false);
    const hex = OFFICIAL_SIGNATURE.split("=")[1] as string;
    expect(verifyEasypostSignature({ "x-hmac-signature": hex }, officialBody, "sécret")).toBe(
      false,
    );
    expect(
      verifyEasypostSignature(
        { "x-hmac-signature": `hmac-sha256-hex=${hex.slice(0, -2)}` },
        officialBody,
        OFFICIAL_SECRET,
      ),
    ).toBe(false);
    expect(
      verifyEasypostSignature({ "x-hmac-signature": "some-signature" }, officialBody, "x"),
    ).toBe(false);
  });

  it("signs with the mock secret by default (no EASYPOST_WEBHOOK_SECRET in tests)", () => {
    const body = '{"id":"evt_x"}';
    expect(
      verifyEasypostSignature(
        { "x-hmac-signature": signEasypostBody(body) },
        body,
        MOCK_EASYPOST_WEBHOOK_SECRET,
      ),
    ).toBe(true);
  });
});

describe("EasyPost event parsing", () => {
  it("normalizes the official tracker.updated event without copying PII", () => {
    const e = parseEasypostEvent(officialBody);
    expect(e).toMatchObject({ id: "evt_1", description: "tracker.updated", mode: "production" });
    expect(e?.tracker).toMatchObject({
      trackerId: "trk_1",
      trackingCode: "1",
      carrierShipmentId: null,
      status: "in_transit",
      statusDetail: "arrived_at_facility",
      deliveredAt: null,
    });
    // The latest scan in tracking_details, not the event's own timestamp.
    const latest = JSON.parse(officialBody)
      .result.tracking_details.map((d: { datetime: string }) => new Date(d.datetime).getTime())
      .reduce((a: number, b: number) => Math.max(a, b));
    expect(e?.tracker?.occurredAt.getTime()).toBe(latest);
    expect(JSON.stringify(e)).not.toMatch(/ORLANDO|tracking_location|signed_by/);
  });

  it("delivered takes the delivery scan's time", () => {
    const e = parseEasypostEvent(
      JSON.stringify({
        id: "evt_2",
        object: "Event",
        description: "tracker.updated",
        mode: "test",
        result: {
          id: "trk_2",
          object: "Tracker",
          tracking_code: "9400X",
          status: "delivered",
          shipment_id: "shp_2",
          tracking_details: [
            { status: "in_transit", datetime: "2026-09-20T10:00:00Z" },
            { status: "delivered", datetime: "2026-09-22T15:30:00Z" },
          ],
        },
      }),
    );
    expect(e?.tracker?.deliveredAt?.toISOString()).toBe("2026-09-22T15:30:00.000Z");
    expect(e?.tracker?.carrierShipmentId).toBe("shp_2");
  });

  it("other events carry no tracker; junk and events without an id are rejected", () => {
    const refund = parseEasypostEvent(
      JSON.stringify({
        id: "evt_3",
        description: "refund.successful",
        result: { object: "Refund" },
      }),
    );
    expect(refund).toMatchObject({ id: "evt_3", tracker: null });
    expect(parseEasypostEvent("not json")).toBeNull();
    expect(parseEasypostEvent(JSON.stringify({ description: "tracker.updated" }))).toBeNull();
    expect(parseEasypostEvent("[]")).toBeNull();
  });

  it("accepts only the event mode of the configured key", () => {
    expect(acceptedEventMode("EZTK123")).toBe("test");
    expect(acceptedEventMode("EZAK123")).toBe("production");
    expect(acceptedEventMode(undefined)).toBeNull();
  });
});
