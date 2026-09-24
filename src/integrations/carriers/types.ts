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

/** `pending`: the carrier accepted the refund request but hasn't refunded yet (EasyPost `submitted`). */
export type VoidResult = { ok: true; pending: boolean } | { ok: false; detail: string };

/** What the carrier has for one of its shipments: the bought label (if any) and refund state. */
export type CarrierLookup = { label: PurchasedLabel | null; refundStatus: string | null };

/**
 * Where a label PDF is stored: one fixed key per carrier shipment, so a retried buy or read-back
 * overwrites the same object instead of leaving a second copy.
 */
export function labelObjectKey(companyId: string, carrierShipmentId: string) {
  return `${companyId}/label/${carrierShipmentId.replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`;
}

/**
 * One carrier provider (EasyPost or the mock). Normalizes rates to cents and stores the label
 * PDF in S3 itself, so the shipping service only deals in keys.
 */
export interface CarrierAdapter {
  provider: "easypost" | "mock";
  rate(req: RateRequest): Promise<{ carrierShipmentId: string; rates: CarrierRate[] }>;
  /**
   * Buy the rate on `carrierShipmentId`. Not idempotent at the carrier (EasyPost documents no
   * idempotency on /buy): call it only with a committed `buying` intent, and after `lookup`
   * shows no label when resuming (R8).
   */
  buy(req: BuyRequest): Promise<PurchasedLabel>;
  /** Read back a carrier shipment before any retry of `buy` or `void`. Never charges. */
  lookup(input: {
    companyId: string;
    shipmentId: string;
    carrierShipmentId: string;
  }): Promise<CarrierLookup>;
  /** Ask for a refund. Safe to repeat: an already-requested refund counts as success. */
  void(input: {
    companyId: string;
    carrierShipmentId: string;
    trackingCode: string;
  }): Promise<VoidResult>;
}

/**
 * `outcome` says whether the carrier may have acted: `not_done` for a clear refusal (4xx,
 * validation), `unknown` for a timeout, network error or 5xx, where a retry must read back first.
 */
export class CarrierError extends Error {
  public readonly outcome: "not_done" | "unknown";
  constructor(
    public readonly provider: string,
    public readonly code: "address_invalid" | "rate_expired" | "upstream",
    message: string,
    outcome?: "not_done" | "unknown",
  ) {
    super(message);
    this.outcome = outcome ?? (code === "upstream" ? "unknown" : "not_done");
  }
}
