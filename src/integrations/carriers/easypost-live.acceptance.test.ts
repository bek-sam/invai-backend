import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../api/app";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, labels, orderItems, shipments } from "../../db/schema";
import * as outbox from "../../lib/outbox";
import { runJobInline } from "../../lib/queues";
import { headObject } from "../../lib/s3";
import { easypostEventJob } from "../../modules/shipping/jobs";
import * as svc from "../../modules/shipping/service";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { createEasypostCarrier } from "./easypost";
import { signEasypostBody } from "./easypost/webhook";
import * as carriers from "./index";

/*
 * T-20-3 (B-71) AC3, EasyPost: the real REST adapter under the real shipping service, with
 * `fetch` answering in EasyPost's recorded shapes (seed-like data, no PII). Proves the request
 * method and path, that Basic auth is sent (never asserting the key), that our shipment id is
 * the `reference` on the carrier shipment (the buy's idempotency handle), that a crash between
 * `POST /buy` and the commit is finished by `GET /shipments/{id}` and never a second buy, and
 * that a signed `tracker.updated` webhook moves the shipment to in_transit, then delivered.
 */

vi.mock("./index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index")>();
  return { ...actual, carrierAdapter: vi.fn(actual.carrierAdapter) };
});
vi.mock("../../lib/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/outbox")>();
  return { ...actual, emit: vi.fn(actual.emit) };
});

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

const EP = "https://api.easypost.com/v2";
const LABEL_URL = "https://easypost-files.example.test/labels/shp_t203_1.pdf";
const PDF = Buffer.from("%PDF-1.4\n% mock label for tests\n%%EOF\n");

/** A bought EasyPost shipment, as `POST /buy` and `GET /shipments/{id}` return it. */
const boughtShipment = (id: string, trackingCode: string) => ({
  id,
  object: "Shipment",
  reference: null,
  tracking_code: trackingCode,
  selected_rate: {
    id: "rate_t203_ga",
    carrier: "USPS",
    service: "GroundAdvantage",
    rate: "5.12",
    delivery_days: 3,
    delivery_date: null,
  },
  postage_label: { id: "pl_t203_1", label_url: null, label_pdf_url: LABEL_URL },
  tracker: { id: "trk_t203_1", object: "Tracker", public_url: "https://track.easypost.test/x" },
  refund_status: null,
});

describe("T-20-3 EasyPost live adapter over fetch, under the shipping service", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let connectionId: string;
  let calls: Call[];

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    await createLocation(companyId);
    connectionId = (await createConnection(companyId, "csv")).id;
    await withTenant(companyId, (tx) =>
      svc.updateSettings(tx, ctx, {
        fromAddress: {
          name: "Desert Bloom Tees",
          company: null,
          street1: "100 Main St",
          street2: null,
          city: "Phoenix",
          state: "AZ",
          zip: "85004",
          country: "US",
          phone: null,
          email: null,
        },
      }),
    );
    vi.mocked(carriers.carrierAdapter).mockImplementation(async () =>
      createEasypostCarrier("EZTK-test-key-never-asserted"),
    );
  });

  beforeEach(() => {
    calls = [];
    vi.mocked(outbox.emit).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Answers EasyPost calls by method and path; the shipment id and tracking code are per test. */
  function stubEasypost(carrierShipmentId: string, trackingCode: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET";
        const headers = Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        );
        calls.push({
          method,
          url,
          headers,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        const json = (status: number, body: unknown) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });
        if (url === LABEL_URL)
          return new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } });
        if (method === "POST" && url === `${EP}/shipments`)
          return json(201, {
            id: carrierShipmentId,
            object: "Shipment",
            rates: [
              {
                id: "rate_t203_ga",
                carrier: "USPS",
                service: "GroundAdvantage",
                rate: "5.12",
                delivery_days: 3,
                delivery_date: null,
              },
              {
                id: "rate_t203_pm",
                carrier: "USPS",
                service: "Priority",
                rate: "9.10",
                delivery_days: 2,
                delivery_date: null,
              },
            ],
          });
        if (method === "POST" && url === `${EP}/shipments/${carrierShipmentId}/buy`)
          return json(200, boughtShipment(carrierShipmentId, trackingCode));
        if (method === "GET" && url === `${EP}/shipments/${carrierShipmentId}`)
          return json(200, boughtShipment(carrierShipmentId, trackingCode));
        throw new Error(`unexpected EasyPost call ${method} ${url}`);
      }),
    );
  }

  const path = (c: Call) => `${c.method} ${c.url.replace(EP, "")}`;
  const row = async (id: string) => {
    const [r] = await withSystem((tx) => tx.select().from(shipments).where(eq(shipments.id, id)));
    if (!r) throw new Error("shipment missing");
    return r;
  };
  const unitStates = async (orderId: string) =>
    (
      await withSystem((tx) =>
        tx
          .select({ state: orderItems.state })
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId)),
      )
    ).map((r) => r.state);

  async function packedOrder() {
    const { order } = await createOrder(companyId, connectionId, { units: 2, state: "packed" });
    await withSystem((tx) =>
      tx.insert(buyerPii).values({
        companyId,
        orderId: order.id,
        name: "Test Buyer",
        street1: "1 Buyer Way",
        city: "Brooklyn",
        state: "NY",
        zip: "11201",
      }),
    );
    return order;
  }

  it("rates, buys once through a crash, reads back, then a signed tracker webhook delivers it", async () => {
    const carrierShipmentId = `shp_t203_${Date.now().toString(36)}`;
    const trackingCode = `9400111899${Date.now().toString().slice(-12)}`;
    stubEasypost(carrierShipmentId, trackingCode);
    const order = await packedOrder();

    // Rate: POST /shipments with our shipment id as the reference, Basic auth present.
    const quote = await svc.rateOrder(ctx, { orderId: order.id });
    expect(calls.map(path)).toEqual(["POST /shipments"]);
    const create = calls[0] as Call;
    expect(create.headers.authorization).toMatch(/^Basic /);
    expect(create.headers["content-type"]).toBe("application/json");
    expect(create.body).toMatchObject({
      shipment: {
        reference: quote.shipmentId,
        to_address: { city: "Brooklyn", zip: "11201" },
        options: { label_format: "PDF", label_size: "4x6" },
      },
    });
    expect(quote.rates.map((r) => [r.rateId, r.rate])).toEqual([
      ["rate_t203_ga", 512],
      ["rate_t203_pm", 910],
    ]);
    expect((await row(quote.shipmentId)).carrierShipmentId).toBe(carrierShipmentId);

    // Buy, with the commit failing after EasyPost charged.
    calls = [];
    vi.mocked(outbox.emit).mockImplementationOnce(async () => {
      throw new Error("simulated commit failure");
    });
    await expect(
      svc.buyLabel(ctx, { shipmentId: quote.shipmentId, rateId: "rate_t203_ga" }),
    ).rejects.toThrow(/simulated commit failure/);
    expect(calls.map(path)).toEqual([
      `POST /shipments/${carrierShipmentId}/buy`,
      `GET ${LABEL_URL}`,
    ]);
    expect(calls[0]?.body).toEqual({ rate: { id: "rate_t203_ga" } });
    expect(calls[0]?.headers.authorization).toMatch(/^Basic /);
    expect(await row(quote.shipmentId)).toMatchObject({
      status: "buying",
      buyAttemptedAt: null,
      trackingCode: null,
    });
    expect(
      await withSystem((tx) =>
        tx.select().from(labels).where(eq(labels.shipmentId, quote.shipmentId)),
      ),
    ).toHaveLength(0);

    // Retry: read back with GET /shipments/{id}; no second POST /buy.
    calls = [];
    const bought = await svc.buyLabel(ctx, {
      shipmentId: quote.shipmentId,
      rateId: "rate_t203_ga",
    });
    expect(calls.map(path)).toEqual([`GET /shipments/${carrierShipmentId}`, `GET ${LABEL_URL}`]);
    expect(calls.some((c) => c.url.endsWith("/buy"))).toBe(false);
    expect(bought).toMatchObject({
      status: "labeled",
      trackingCode,
      postage: 512,
      trackingUrl: "https://track.easypost.test/x",
    });
    const labelRows = await withSystem((tx) =>
      tx.select().from(labels).where(eq(labels.shipmentId, quote.shipmentId)),
    );
    expect(labelRows).toHaveLength(1);
    expect(labelRows[0]).toMatchObject({
      status: "purchased",
      carrierLabelId: "pl_t203_1",
      postageCents: 512,
      labelKey: carriers.labelObjectKey(companyId, carrierShipmentId),
    });
    expect((await headObject(labelRows[0]?.labelKey as string)).exists).toBe(true);
    // Buying again is the stored label: no carrier call at all.
    calls = [];
    expect(
      (await svc.buyLabel(ctx, { shipmentId: quote.shipmentId, rateId: "rate_t203_ga" })).id,
    ).toBe(quote.shipmentId);
    expect(calls).toHaveLength(0);
    expect(await unitStates(order.id)).toEqual(["packed", "packed"]);

    // Tracker webhook: signed body -> route -> job -> shipment state. No outbound fetch.
    const enqueue = vi.spyOn(easypostEventJob, "enqueue").mockResolvedValue({} as never);
    const event = (id: string, status: "in_transit" | "delivered", at: string) =>
      JSON.stringify({
        id,
        object: "Event",
        description: "tracker.updated",
        mode: "test",
        result: {
          id: "trk_t203_1",
          object: "Tracker",
          tracking_code: trackingCode,
          status,
          shipment_id: carrierShipmentId,
          tracking_details: [{ status, datetime: at }],
        },
      });
    const post = (body: string) =>
      app.request("/webhooks/easypost", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hmac-signature": signEasypostBody(body) },
        body,
      });
    const transitId = `evt_t203_${carrierShipmentId}_transit`;
    const transit = event(transitId, "in_transit", "2026-09-29T10:00:00Z");
    expect((await post(transit)).status).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const queued = enqueue.mock.calls[0]?.[0] as Parameters<typeof easypostEventJob.enqueue>[0];
    expect(await runJobInline(easypostEventJob, queued)).toMatchObject({
      status: "processed",
      from: "labeled",
      to: "in_transit",
    });
    expect(await row(quote.shipmentId)).toMatchObject({ status: "in_transit", trackingCode });
    expect(await unitStates(order.id)).toEqual(["shipped", "shipped"]);

    // EasyPost redelivers the same event: acknowledged, not queued again.
    const again = await post(transit);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(enqueue).toHaveBeenCalledTimes(1);

    const delivered = event(`${transitId}_delivered`, "delivered", "2026-10-01T15:00:00Z");
    expect((await post(delivered)).status).toBe(200);
    const queued2 = enqueue.mock.calls[1]?.[0] as Parameters<typeof easypostEventJob.enqueue>[0];
    expect(await runJobInline(easypostEventJob, queued2)).toMatchObject({ to: "delivered" });
    const final = await row(quote.shipmentId);
    expect(final.status).toBe("delivered");
    expect(final.deliveredAt?.toISOString()).toBe("2026-10-01T15:00:00.000Z");
    expect(await unitStates(order.id)).toEqual(["delivered", "delivered"]);
    expect(calls).toHaveLength(0);
    enqueue.mockRestore();
  });

  it("a timeout on POST /buy is an unknown outcome: the retry reads back and never buys again", async () => {
    const carrierShipmentId = `shp_t203_to_${Date.now().toString(36)}`;
    const trackingCode = `9400111899${(Date.now() + 7).toString().slice(-12)}`;
    stubEasypost(carrierShipmentId, trackingCode);
    const order = await packedOrder();
    const quote = await svc.rateOrder(ctx, { orderId: order.id });
    const real = fetch;
    // The buy reaches EasyPost (it sells the label) but the answer never arrives.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/buy")) {
          calls.push({ method: "POST", url, headers: {}, body: null });
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        return real(url, init);
      }),
    );
    calls = [];
    await expect(
      svc.buyLabel(ctx, { shipmentId: quote.shipmentId, rateId: "rate_t203_ga" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_FAILED" });
    expect(calls.map(path)).toEqual([`POST /shipments/${carrierShipmentId}/buy`]);
    expect(await row(quote.shipmentId)).toMatchObject({ status: "buying", buyAttemptedAt: null });

    calls = [];
    const bought = await svc.buyLabel(ctx, {
      shipmentId: quote.shipmentId,
      rateId: "rate_t203_ga",
    });
    expect(calls.map(path)).toEqual([`GET /shipments/${carrierShipmentId}`, `GET ${LABEL_URL}`]);
    expect(bought).toMatchObject({ status: "labeled", trackingCode });
  });
});
