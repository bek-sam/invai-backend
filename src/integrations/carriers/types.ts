import type { Address } from "../../db/schema";

/** `mock` is the sandbox carrier; real rates come back as usps/ups. */
export type CarrierCode = "usps" | "ups" | "mock";

export type Parcel = { lengthIn: number; widthIn: number; heightIn: number; weightOz: number };

export type CarrierRate = {
  rateId: string;
  carrier: CarrierCode;
  service: string;
  serviceLabel: string;
  rateCents: number;
  deliveryDays: number | null;
  estimatedDeliveryAt: string | null;
};

export type RateRequest = {
  companyId: string;
  /** Our shipment id; mock rate ids and references are derived from it. */
  shipmentId: string;
  from: Address;
  to: Address;
  parcel: Parcel;
};

export type BuyRequest = RateRequest & {
  carrierShipmentId: string;
  rate: CarrierRate;
};

export type PurchasedLabel = {
  trackingCode: string;
  trackingUrl: string | null;
  /** S3 key of the 4x6 label PDF (the adapter stores it). */
  labelKey: string;
  carrierLabelId: string | null;
  postageCents: number;
};

export type VoidResult = { ok: true } | { ok: false; detail: string };

/**
 * One carrier provider (EasyPost or the mock). Normalizes rates to cents and stores the label
 * PDF in S3 itself, so the shipping service only deals in keys.
 */
export interface CarrierAdapter {
  provider: "easypost" | "mock";
  rate(req: RateRequest): Promise<{ carrierShipmentId: string; rates: CarrierRate[] }>;
  buy(req: BuyRequest): Promise<PurchasedLabel>;
  void(input: { carrierShipmentId: string; trackingCode: string }): Promise<VoidResult>;
}

export class CarrierError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: "address_invalid" | "rate_expired" | "upstream",
    message: string,
  ) {
    super(message);
  }
}
