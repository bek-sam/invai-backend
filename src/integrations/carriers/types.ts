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

/** Where a SCAN form PDF is stored: under `label` so only shipping roles can download it. */
export function scanFormObjectKey(companyId: string, formRef: string) {
  return `${companyId}/label/scanform-${formRef.replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`;
}

/**
 * A carrier address check. `corrected` carries the carrier's standardized address; `detail` is
 * the carrier's reason for `failed` and never contains the address. Both are buyer PII-adjacent:
 * return them to the caller, never log them.
 */
export type AddressCheck = {
  status: "verified" | "corrected" | "failed";
  suggestion: Address | null;
  detail: string | null;
};

/**
 * A SCAN form the carrier made. `status: "creating"` means the carrier accepted it and is still
 * rendering the PDF (EasyPost is async): `fileKey` stays null until a `scanFormOf` read-back
 * finds the finished file.
 */
export type CarrierScanForm = {
  carrierFormId: string | null;
  status: "creating" | "created";
  fileKey: string | null;
};

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
 * Carrier calls beyond rate/buy/void (B-25): address checks and USPS SCAN forms. Separate from
 * `CarrierAdapter` so the many test fakes of the buy path don't have to implement them.
 */
export interface CarrierExtras {
  /** Check a ship-to address. Never charges; safe to repeat. */
  verifyAddress(input: { companyId: string; address: Address }): Promise<AddressCheck>;
  /**
   * Manifest bought labels on one SCAN form (USPS). A carrier shipment can be on one form only,
   * so a repeat after an unknown outcome must read back with `scanFormOf` first.
   */
  createScanForm(input: {
    companyId: string;
    /** Our form id: names the stored PDF. */
    formId: string;
    date: string;
    carrierShipmentIds: string[];
  }): Promise<CarrierScanForm>;
  /** Read-back: the form a carrier shipment is already on, or null. */
  scanFormOf(input: {
    companyId: string;
    formId: string;
    carrierShipmentId: string;
  }): Promise<CarrierScanForm | null>;
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
