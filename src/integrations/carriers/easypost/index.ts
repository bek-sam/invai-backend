import type { Address } from "../../../db/schema";
import { env } from "../../../env";
import { logger } from "../../../lib/log";
import { putObject } from "../../../lib/s3";
import {
  type CarrierAdapter,
  type CarrierCode,
  CarrierError,
  type CarrierRate,
  labelObjectKey,
  type PurchasedLabel,
} from "../types";

/*
 * EasyPost REST adapter (https://docs.easypost.com/docs/shipments). No SDK: plain fetch with
 * HTTP Basic auth (the API key as the username).
 *   POST /v2/shipments               create with from/to/parcel -> rates[]
 *   POST /v2/shipments/{id}/buy      { rate: { id } } -> tracking_code, postage_label, tracker
 *   GET  /v2/shipments/{id}          read-back before any retry (postage_label, refund_status)
 *   POST /v2/shipments/{id}/refund   -> refund_status (submitted | refunded | rejected)
 * Labels are requested as 4x6 PDF and copied into our bucket so they outlive EasyPost's URLs.
 * /buy has no documented idempotency: the shipping service commits a `buying` intent first and
 * reads the shipment back before buying again (research 10 R8). Our shipment id is sent as the
 * EasyPost `reference` when the shipment is created at rating time.
 */

const log = logger("carrier.easypost");
const BASE = "https://api.easypost.com/v2";

type EpRate = {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  delivery_days: number | null;
  delivery_date: string | null;
};
type EpShipment = {
  id: string;
  rates?: EpRate[];
  tracking_code?: string | null;
  selected_rate?: EpRate | null;
  postage_label?: { id: string; label_url?: string | null; label_pdf_url?: string | null } | null;
  tracker?: { public_url?: string | null } | null;
  refund_status?: string | null;
  messages?: { carrier: string; message: string }[];
};
type EpError = { error?: { code?: string; message?: string } };

const SERVICE_LABELS: Record<string, string> = {
  GroundAdvantage: "USPS Ground Advantage",
  Priority: "USPS Priority Mail",
  Express: "USPS Priority Mail Express",
  Ground: "UPS Ground",
  "2ndDayAir": "UPS 2nd Day Air",
  NextDayAir: "UPS Next Day Air",
};

function authHeader(apiKey: string) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

async function call<T>(
  apiKey: string,
  path: string,
  body?: unknown,
  method: "GET" | "POST" = "POST",
): Promise<T> {
  // A timeout or network error leaves the outcome unknown: the caller reads back before retrying.
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: authHeader(apiKey), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((err) => {
    throw new CarrierError("easypost", "upstream", String(err), "unknown");
  });
  const json = (await res.json().catch(() => ({}))) as T & EpError;
  if (!res.ok) {
    const code = json.error?.code ?? String(res.status);
    const message = json.error?.message ?? `HTTP ${res.status}`;
    log.warn("easypost error", { path, code, message });
    if (code.startsWith("ADDRESS") || code.includes("ADDRESS"))
      throw new CarrierError("easypost", "address_invalid", message);
    if (code === "SHIPMENT.RATE.EXPIRED" || code.includes("RATE"))
      throw new CarrierError("easypost", "rate_expired", message);
    throw new CarrierError(
      "easypost",
      "upstream",
      `${code}: ${message}`,
      res.status >= 500 ? "unknown" : "not_done",
    );
  }
  return json;
}

function epAddress(a: Address) {
  return {
    name: a.name,
    company: a.company ?? undefined,
    street1: a.street1,
    street2: a.street2 ?? undefined,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country || "US",
    phone: a.phone ?? undefined,
    email: a.email ?? undefined,
  };
}

function carrierCode(epCarrier: string): CarrierCode | null {
  const c = epCarrier.toLowerCase();
  if (c === "usps") return "usps";
  if (c === "ups" || c === "upsdap") return "ups";
  return null;
}

function toRate(r: EpRate): CarrierRate | null {
  const carrier = carrierCode(r.carrier);
  if (!carrier) return null;
  return {
    rateId: r.id,
    carrier,
    service: r.service,
    serviceLabel: SERVICE_LABELS[r.service] ?? `${r.carrier} ${r.service}`,
    rateCents: Math.round(Number.parseFloat(r.rate) * 100),
    deliveryDays: r.delivery_days ?? null,
    estimatedDeliveryAt: r.delivery_date ? new Date(r.delivery_date).toISOString() : null,
  };
}

/** Copy a bought shipment's label PDF into our bucket (fixed key, so repeats overwrite). */
async function storeLabel(
  companyId: string,
  shipment: EpShipment,
  fallbackCents: number | null,
): Promise<PurchasedLabel | null> {
  const labelUrl = shipment.postage_label?.label_pdf_url ?? shipment.postage_label?.label_url;
  if (!shipment.tracking_code || !labelUrl) return null;
  const pdf = await fetch(labelUrl, { signal: AbortSignal.timeout(30_000) }).catch((err) => {
    throw new CarrierError("easypost", "upstream", `label download: ${String(err)}`, "unknown");
  });
  if (!pdf.ok)
    throw new CarrierError("easypost", "upstream", `label download ${pdf.status}`, "unknown");
  const labelKey = labelObjectKey(companyId, shipment.id);
  await putObject(labelKey, Buffer.from(await pdf.arrayBuffer()), "application/pdf");
  const selected = shipment.selected_rate
    ? Math.round(Number.parseFloat(shipment.selected_rate.rate) * 100)
    : null;
  return {
    trackingCode: shipment.tracking_code,
    trackingUrl: shipment.tracker?.public_url ?? null,
    labelKey,
    carrierLabelId: shipment.postage_label?.id ?? null,
    postageCents: selected ?? fallbackCents ?? 0,
  };
}

export function createEasypostCarrier(apiKey: string): CarrierAdapter {
  return {
    provider: "easypost",

    async rate(req) {
      const shipment = await call<EpShipment>(apiKey, "/shipments", {
        shipment: {
          reference: req.shipmentId,
          from_address: epAddress(req.from),
          to_address: epAddress(req.to),
          parcel: {
            length: req.parcel.lengthIn,
            width: req.parcel.widthIn,
            height: req.parcel.heightIn,
            weight: req.parcel.weightOz,
          },
          options: { label_format: "PDF", label_size: "4x6" },
        },
      });
      const rates = (shipment.rates ?? []).map(toRate).filter((r): r is CarrierRate => !!r);
      if (!rates.length) {
        const why = shipment.messages?.map((m) => m.message).join("; ") || "no rates returned";
        throw new CarrierError("easypost", "upstream", why);
      }
      return { carrierShipmentId: shipment.id, rates };
    },

    async buy(req) {
      const bought = await call<EpShipment>(apiKey, `/shipments/${req.carrierShipmentId}/buy`, {
        rate: { id: req.rate.rateId },
      });
      const label = await storeLabel(req.companyId, bought, req.rate.rateCents);
      // Charged but no usable label: unknown, so the retry reads the shipment back.
      if (!label) throw new CarrierError("easypost", "upstream", "purchase returned no label");
      return label;
    },

    async lookup({ companyId, carrierShipmentId }) {
      const shipment = await call<EpShipment>(
        apiKey,
        `/shipments/${carrierShipmentId}`,
        undefined,
        "GET",
      );
      return {
        label: await storeLabel(companyId, shipment, null),
        refundStatus: shipment.refund_status ?? null,
      };
    },

    async void({ carrierShipmentId }) {
      const res = await call<EpShipment>(apiKey, `/shipments/${carrierShipmentId}/refund`);
      if (res.refund_status === "rejected" || res.refund_status === "not_applicable")
        return { ok: false, detail: `refund ${res.refund_status}` };
      return { ok: true, pending: res.refund_status !== "refunded" };
    },
  };
}

export const easypostCarrier: CarrierAdapter | null = env.EASYPOST_API_KEY
  ? createEasypostCarrier(env.EASYPOST_API_KEY)
  : null;
