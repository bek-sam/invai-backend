import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBucket, getObject } from "../../../lib/s3";
import { mockCarrier, mockVerifyAddress } from "../mock";
import { CarrierError } from "../types";
import { createEasypostCarrier, isEasypostFileUrl, RETRY_429 } from "./index";

/*
 * B-25: EasyPost address verification and SCAN forms against a stubbed fetch. Fixtures follow
 * the documented response shapes (docs.easypost.com/docs/addresses and /docs/scan-form, checked
 * 2026-09-29) with fake addresses; no sandbox key exists yet, so they are not recorded traffic.
 */

const fx = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8"));

type Call = { url: string; method: string; body: unknown; redirect?: string };
let calls: Call[];
let replies: Array<() => Response>;
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pdf = () => () =>
  new Response(Buffer.from("%PDF-1.4 sandbox scan form"), {
    status: 200,
    headers: { "content-type": "application/pdf" },
  });

beforeAll(async () => {
  await ensureBucket();
});
beforeEach(() => {
  calls = [];
  replies = [];
  RETRY_429.baseMs = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        redirect: init.redirect,
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

const companyId = "00000000-0000-4000-8000-0000000000a1";
const ep = createEasypostCarrier("EZTK_test");
const address = (over: Partial<Record<string, string | null>> = {}) => ({
  name: "Dana Whitfield",
  company: null,
  street1: "100 Example Ave",
  street2: null,
  city: "Phoenix",
  state: "AZ",
  zip: "85003",
  country: "US",
  phone: "+1 555-0141",
  email: null,
  ...over,
});

describe("EasyPost address verification", () => {
  it("sends verify at the top level and reads a matching address as verified (ZIP+4 is not a change)", async () => {
    replies.push(json(200, fx("address-verified")));
    const out = await ep.verifyAddress({ companyId, address: address() });
    expect(out).toEqual({ status: "verified", suggestion: null, detail: null });
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]?.url).toMatch(/\/v2\/addresses$/);
    expect(calls[0]?.body).toMatchObject({ verify: true, address: { street1: "100 Example Ave" } });
  });

  it("returns EasyPost's standardized address as a correction, keeping the order's name and phone", async () => {
    replies.push(json(200, fx("address-corrected")));
    const out = await ep.verifyAddress({
      companyId,
      address: address({
        street1: "200 Sample Road",
        street2: "Apt 4",
        city: "Tempe",
        zip: "85281",
      }),
    });
    expect(out.status).toBe("corrected");
    expect(out.suggestion).toMatchObject({
      name: "Dana Whitfield",
      phone: "+1 555-0141",
      street1: "200 SAMPLE RD APT 4",
      street2: null,
      zip: "85281-0001",
    });
  });

  it("maps a failed delivery check to failed with the carrier's reason, not the address", async () => {
    replies.push(json(200, fx("address-failed")));
    const out = await ep.verifyAddress({
      companyId,
      address: address({ street1: "1 Nowhere Ln" }),
    });
    expect(out).toEqual({ status: "failed", suggestion: null, detail: "Address not found" });
  });

  it("retries a 429 (verification charges nothing)", async () => {
    replies.push(json(429, { error: { code: "RATE_LIMITED", message: "slow down" } }));
    replies.push(json(200, fx("address-verified")));
    expect((await ep.verifyAddress({ companyId, address: address() })).status).toBe("verified");
    expect(calls).toHaveLength(2);
  });
});

describe("EasyPost SCAN forms", () => {
  it("creates one form for the shipments and copies the PDF from EasyPost's file host", async () => {
    replies.push(json(200, fx("scan-form-created")), pdf());
    const out = await ep.createScanForm({
      companyId,
      formId: "11111111-1111-4111-8111-111111111111",
      date: "2026-09-29",
      carrierShipmentIds: ["shp_a", "shp_b"],
    });
    expect(calls[0]?.body).toEqual({ shipments: [{ id: "shp_a" }, { id: "shp_b" }] });
    expect(calls[1]?.redirect).toBe("manual");
    expect(out).toEqual({
      carrierFormId: "sf_00000000000000000000000000000001",
      status: "created",
      fileKey: `${companyId}/label/scanform-11111111-1111-4111-8111-111111111111.pdf`,
    });
    expect((await getObject(out.fileKey as string)).toString()).toContain("%PDF");
  });

  it("a form still rendering is `creating` with no file yet", async () => {
    replies.push(json(200, fx("scan-form-creating")));
    const out = await ep.createScanForm({
      companyId,
      formId: "22222222-2222-4222-8222-222222222222",
      date: "2026-09-29",
      carrierShipmentIds: ["shp_a"],
    });
    expect(out).toMatchObject({ status: "creating", fileKey: null });
  });

  it("a failed form is a clear not-done refusal; a 429 is never re-sent", async () => {
    replies.push(json(200, fx("scan-form-failed")));
    const err = await ep
      .createScanForm({ companyId, formId: "x", date: "2026-09-29", carrierShipmentIds: ["shp_a"] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CarrierError);
    expect(err).toMatchObject({ outcome: "not_done", message: expect.stringMatching(/same from/) });

    replies.push(json(429, { error: { code: "RATE_LIMITED", message: "slow down" } }));
    await expect(
      ep.createScanForm({ companyId, formId: "x", date: "2026-09-29", carrierShipmentIds: ["a"] }),
    ).rejects.toBeInstanceOf(CarrierError);
    expect(calls).toHaveLength(2);
  });

  it("reads back the form a shipment is already on", async () => {
    replies.push(
      json(200, { id: "shp_a", scan_form: { id: "sf_00000000000000000000000000000001" } }),
      json(200, fx("scan-form-created")),
      pdf(),
    );
    const out = await ep.scanFormOf({
      companyId,
      formId: "33333333-3333-4333-8333-333333333333",
      carrierShipmentId: "shp_a",
    });
    expect(out).toMatchObject({ carrierFormId: "sf_00000000000000000000000000000001" });
    replies.push(json(200, { id: "shp_b", scan_form: null }));
    expect(await ep.scanFormOf({ companyId, formId: "y", carrierShipmentId: "shp_b" })).toBeNull();
  });

  it("downloads form files only from EasyPost hosts", () => {
    expect(isEasypostFileUrl("https://easypost-files.s3.us-west-2.amazonaws.com/f.pdf")).toBe(true);
    expect(isEasypostFileUrl("https://files.easypost.com/f.pdf")).toBe(true);
    expect(isEasypostFileUrl("http://easypost-files.s3.amazonaws.com/f.pdf")).toBe(false);
    expect(isEasypostFileUrl("https://evil.example.com/easypost-files.pdf")).toBe(false);
    expect(isEasypostFileUrl("https://easypost.com.evil.example/f.pdf")).toBe(false);
  });
});

describe("mock carrier address fixtures", () => {
  it("is deterministic: verified, corrected (USPS suffix), failed (000 ZIP or bad ZIP)", async () => {
    expect(mockVerifyAddress(address({ street1: "4410 N 40th St" })).status).toBe("verified");
    const c = mockVerifyAddress(address({ street1: "200 Sample Road", city: "Tempe" }));
    expect(c).toMatchObject({
      status: "corrected",
      suggestion: { street1: "200 SAMPLE RD", city: "TEMPE", name: "Dana Whitfield" },
    });
    expect(mockVerifyAddress(address({ zip: "00012" })).status).toBe("failed");
    expect(mockVerifyAddress(address({ zip: "8500" }))).toEqual({
      status: "failed",
      suggestion: null,
      detail: "Address not found",
    });
    expect(await mockCarrier.verifyAddress({ companyId, address: address() })).toEqual(
      mockVerifyAddress(address()),
    );
  });
});
