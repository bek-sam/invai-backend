import { createHash } from "node:crypto";
import { getObject, headObject, putObject } from "../../../lib/s3";
import { imaging } from "../../imaging/client";
import type { TrackerUpdate, TrackingAdapter } from "../tracking";
import {
  type CarrierAdapter,
  CarrierError,
  type CarrierLookup,
  type CarrierRate,
  labelObjectKey,
  type Parcel,
  type PurchasedLabel,
  type RateRequest,
} from "../types";

/*
 * Sandbox carrier used when no EASYPOST_API_KEY is set. Rates are deterministic from weight and a
 * zone derived from the ZIP prefixes, tracking codes are derived from the shipment id, and the
 * 4x6 label PDF comes from imaging `POST /labels/mock`. The "carrier's records" live in the
 * bucket next to the PDF (a small JSON per carrier shipment), so a read-back after a crash sees
 * what an earlier process bought, like EasyPost `GET /shipments/{id}` would.
 */

/** `boughtAt` is missing on records written before tracking existed. */
type MockRecord = { label: PurchasedLabel; refundStatus: string | null; boughtAt?: string };

const recordKey = (companyId: string, carrierShipmentId: string) =>
  labelObjectKey(companyId, carrierShipmentId).replace(/\.pdf$/, ".json");

async function readRecord(companyId: string, carrierShipmentId: string) {
  const key = recordKey(companyId, carrierShipmentId);
  if (!(await headObject(key)).exists) return null;
  return JSON.parse((await getObject(key)).toString("utf8")) as MockRecord;
}

async function writeRecord(companyId: string, carrierShipmentId: string, record: MockRecord) {
  await putObject(
    recordKey(companyId, carrierShipmentId),
    Buffer.from(JSON.stringify(record)),
    "application/json",
  );
}

type Service = {
  carrier: "usps" | "ups";
  service: string;
  label: string;
  price: (oz: number, zone: number) => number;
  days: (zone: number) => number;
};

const lbs = (oz: number) => Math.max(1, Math.ceil(oz / 16));

export const MOCK_SERVICES: Service[] = [
  {
    carrier: "usps",
    service: "GroundAdvantage",
    label: "USPS Ground Advantage",
    price: (oz, zone) =>
      oz <= 15.99 ? 400 + Math.ceil(oz / 4) * 35 + zone * 28 : 700 + lbs(oz) * 110 + zone * 60,
    days: (zone) => Math.min(5, 2 + Math.ceil(zone / 3)),
  },
  {
    carrier: "usps",
    service: "Priority",
    label: "USPS Priority Mail",
    price: (oz, zone) => 850 + lbs(oz) * 150 + zone * 75,
    days: (zone) => (zone <= 4 ? 2 : 3),
  },
  {
    carrier: "ups",
    service: "Ground",
    label: "UPS Ground",
    price: (oz, zone) => 1050 + lbs(oz) * 120 + zone * 70,
    days: (zone) => Math.min(5, 1 + Math.ceil(zone / 2)),
  },
];

/** USPS-style zone 1..8 from the distance between 3-digit ZIP prefixes. */
export function mockZone(fromZip: string, toZip: string): number {
  const a = Number.parseInt(fromZip.replace(/\D/g, "").slice(0, 3), 10);
  const b = Number.parseInt(toZip.replace(/\D/g, "").slice(0, 3), 10);
  if (Number.isNaN(a) || Number.isNaN(b)) return 5;
  return Math.min(8, 1 + Math.floor(Math.abs(a - b) / 100));
}

function digits(seed: string, n: number): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  let out = "";
  for (let i = 0; out.length < n; i++)
    out += (Number.parseInt(hex[i % hex.length] ?? "0", 16) % 10).toString();
  return out;
}

export function mockTrackingCode(carrier: "usps" | "ups", seed: string) {
  return carrier === "ups" ? `1ZMOCK${digits(seed, 12)}` : `9400${digits(seed, 18)}`;
}

export function mockTrackingUrl(carrier: "usps" | "ups", code: string) {
  return carrier === "ups"
    ? `https://www.ups.com/track?tracknum=${code}`
    : `https://tools.usps.com/go/TrackConfirmAction?tLabels=${code}`;
}

export function mockRates(
  req: Pick<RateRequest, "shipmentId" | "from" | "to" | "parcel">,
  now = new Date(),
): CarrierRate[] {
  const zone = mockZone(req.from.zip, req.to.zip);
  return MOCK_SERVICES.map((s) => {
    const days = s.days(zone);
    return {
      rateId: `mock_${s.carrier}_${s.service}_${req.shipmentId.slice(0, 8)}`,
      carrier: s.carrier,
      service: s.service,
      serviceLabel: s.label,
      rateCents: s.price(req.parcel.weightOz, zone),
      deliveryDays: days,
      estimatedDeliveryAt: new Date(now.getTime() + days * 86400_000).toISOString(),
    };
  });
}

function validate(to: RateRequest["to"], parcel: Parcel) {
  if (!to.street1?.trim() || !/^\d{5}(-\d{4})?$/.test(to.zip.trim()))
    throw new CarrierError("mock", "address_invalid", "Street and a 5-digit ZIP are required");
  if (parcel.weightOz > 70 * 16)
    throw new CarrierError("mock", "upstream", "Parcel over 70 lb", "not_done");
}

export const mockCarrier: CarrierAdapter = {
  provider: "mock",

  async rate(req) {
    validate(req.to, req.parcel);
    return {
      carrierShipmentId: `shp_mock_${req.shipmentId.replace(/-/g, "")}`,
      rates: mockRates(req),
    };
  },

  async buy(req) {
    validate(req.to, req.parcel);
    const existing = await readRecord(req.companyId, req.carrierShipmentId);
    // Like EasyPost, a carrier shipment is bought once; buying it again is refused.
    if (existing)
      throw new CarrierError("mock", "upstream", "Shipment already has postage", "not_done");
    const carrier = req.rate.carrier === "ups" ? "ups" : "usps";
    const trackingCode = mockTrackingCode(carrier, `${req.shipmentId}:${req.rate.service}`);
    const labelKey = labelObjectKey(req.companyId, req.carrierShipmentId);
    const place = (a: RateRequest["from"]) => ({
      name: a.name,
      city: a.city,
      state: a.state,
      zip: a.zip,
    });
    await imaging.mockLabel({
      shipment_id: req.shipmentId,
      carrier: carrier.toUpperCase(),
      service: req.rate.serviceLabel,
      tracking_code: trackingCode,
      from: place(req.from),
      to: place(req.to),
      weight_oz: req.parcel.weightOz,
      out_key: labelKey,
    });
    const label: PurchasedLabel = {
      trackingCode,
      trackingUrl: mockTrackingUrl(carrier, trackingCode),
      labelKey,
      carrierLabelId: `pl_mock_${trackingCode.slice(-10)}`,
      postageCents: req.rate.rateCents,
    };
    await writeRecord(req.companyId, req.carrierShipmentId, {
      label,
      refundStatus: null,
      boughtAt: new Date().toISOString(),
    });
    return label;
  },

  async lookup({ companyId, carrierShipmentId }): Promise<CarrierLookup> {
    const record = await readRecord(companyId, carrierShipmentId);
    return record ?? { label: null, refundStatus: null };
  },

  async void({ companyId, carrierShipmentId }) {
    const record = await readRecord(companyId, carrierShipmentId);
    if (record && !record.refundStatus)
      await writeRecord(companyId, carrierShipmentId, { ...record, refundStatus: "refunded" });
    return { ok: true, pending: false };
  },
};

/** Hours from purchase to the mock "in transit" and "delivered" scans (same env as the timer). */
const mockHours = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] ? v : fallback;
};

/**
 * Mock tracker for the fallback poll: in transit after MOCK_CARRIER_TRANSIT_HOURS and delivered
 * after MOCK_CARRIER_DELIVERY_HOURS from the purchase, the same clock as the mock timer jobs.
 */
export const mockTracking: TrackingAdapter = {
  provider: "mock",
  async track({ companyId, carrierShipmentId, trackingCode }): Promise<TrackerUpdate | null> {
    const record = await readRecord(companyId, carrierShipmentId);
    if (!record) return null;
    const bought = record.boughtAt ? new Date(record.boughtAt) : null;
    const hours = bought ? (Date.now() - bought.getTime()) / 3600_000 : 0;
    const transit = mockHours("MOCK_CARRIER_TRANSIT_HOURS", 2);
    const delivery = mockHours("MOCK_CARRIER_DELIVERY_HOURS", 72);
    const at = (h: number) => new Date((bought?.getTime() ?? Date.now()) + h * 3600_000);
    const status = !bought
      ? "unknown"
      : hours >= delivery
        ? "delivered"
        : hours >= transit
          ? "in_transit"
          : "pre_transit";
    return {
      trackerId: null,
      trackingCode: record.label.trackingCode ?? trackingCode,
      carrierShipmentId,
      status,
      statusDetail: null,
      occurredAt:
        status === "delivered" ? at(delivery) : status === "in_transit" ? at(transit) : new Date(),
      deliveredAt: status === "delivered" ? at(delivery) : null,
    };
  },
};
