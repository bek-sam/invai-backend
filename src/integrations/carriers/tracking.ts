/*
 * Carrier tracking, normalized. EasyPost Tracker (https://docs.easypost.com/docs/trackers):
 * `status` is one of the TRACKER_STATUSES below, `tracking_details[]` is the scan history with
 * a `datetime` per scan. EasyPost creates a tracker automatically when a shipment is bought,
 * and `POST /trackers` returns the existing tracker for the same tracking code and carrier
 * (created by the same user within 3 months) instead of a duplicate.
 */

export const TRACKER_STATUSES = [
  "unknown",
  "pre_transit",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "available_for_pickup",
  "return_to_sender",
  "failure",
  "cancelled",
  "error",
] as const;
export type TrackerStatus = (typeof TRACKER_STATUSES)[number];

/**
 * One tracker reading, with no PII: the carrier's signature name (`signed_by`) and scan
 * locations are never copied out of the payload.
 */
export type TrackerUpdate = {
  /** EasyPost `trk_...` (null for the mock). */
  trackerId: string | null;
  trackingCode: string;
  /** The carrier shipment the label was bought on (our `shipments.carrierShipmentId`). */
  carrierShipmentId: string | null;
  status: TrackerStatus;
  statusDetail: string | null;
  /** When the carrier's latest scan happened; orders readings that arrive out of order. */
  occurredAt: Date;
  /** The delivery scan's time, when delivered. */
  deliveredAt: Date | null;
};

/** What a tracker reading means for our shipment. */
export type TrackerMove = "in_transit" | "delivered" | "exception" | null;

export function trackerMove(status: TrackerStatus): TrackerMove {
  switch (status) {
    case "in_transit":
    case "out_for_delivery":
    case "available_for_pickup":
      return "in_transit";
    case "delivered":
      return "delivered";
    case "return_to_sender":
    case "failure":
      return "exception";
    default:
      return null;
  }
}

type EpTrackingDetail = { status?: string | null; datetime?: string | null };
export type EpTracker = {
  id?: string | null;
  object?: string;
  tracking_code?: string | null;
  status?: string | null;
  status_detail?: string | null;
  shipment_id?: string | null;
  updated_at?: string | null;
  tracking_details?: EpTrackingDetail[] | null;
};

const validDate = (v: string | null | undefined) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Normalize an EasyPost Tracker. Returns null when it has no tracking code. */
export function normalizeEasypostTracker(t: EpTracker): TrackerUpdate | null {
  if (!t.tracking_code) return null;
  const status = (TRACKER_STATUSES as readonly string[]).includes(t.status ?? "")
    ? (t.status as TrackerStatus)
    : "unknown";
  const details = (t.tracking_details ?? [])
    .map((d) => ({ status: d.status ?? null, at: validDate(d.datetime) }))
    .filter((d): d is { status: string | null; at: Date } => !!d.at);
  const latest = details.reduce<Date | null>((m, d) => (!m || d.at > m ? d.at : m), null);
  const delivered = details.filter((d) => d.status === "delivered").at(-1)?.at ?? null;
  return {
    trackerId: t.id ?? null,
    trackingCode: t.tracking_code,
    carrierShipmentId: t.shipment_id ?? null,
    status,
    statusDetail: t.status_detail ?? null,
    occurredAt: latest ?? validDate(t.updated_at) ?? new Date(),
    deliveredAt: status === "delivered" ? (delivered ?? latest ?? validDate(t.updated_at)) : null,
  };
}

/** Reads a label's tracker from the carrier (daily fallback poll). Never charges. */
export interface TrackingAdapter {
  provider: "easypost" | "mock";
  track(input: {
    companyId: string;
    carrierShipmentId: string;
    trackingCode: string;
    carrier: string | null;
  }): Promise<TrackerUpdate | null>;
}
