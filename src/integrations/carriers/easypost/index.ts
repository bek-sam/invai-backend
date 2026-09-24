import type { Address } from "../../../db/schema";
import { env } from "../../../env";
import { logger } from "../../../lib/log";
import { objectKey, putObject } from "../../../lib/s3";
import { type CarrierAdapter, type CarrierCode, CarrierError, type CarrierRate } from "../types";

/*
 * EasyPost REST adapter (https://docs.easypost.com/docs/shipments). No SDK: plain fetch with
 * HTTP Basic auth (the API key as the username).
 *   POST /v2/shipments               create with from/to/parcel -> rates[]
 *   POST /v2/shipments/{id}/buy      { rate: { id } } -> tracking_code, postage_label, tracker
 *   POST /v2/shipments/{id}/refund   -> refund_status (submitted | refunded | rejected)
 * Labels are requested as 4x6 PDF and copied into our bucket so they outlive EasyPost's URLs.
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

async function call<T>(apiKey: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: authHeader(apiKey), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((err) => {
    throw new CarrierError("easypost", "upstream", String(err));
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
    throw new CarrierError("easypost", "upstream", `${code}: ${message}`);
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
      const labelUrl = bought.postage_label?.label_pdf_url ?? bought.postage_label?.label_url;
      if (!bought.tracking_code || !labelUrl)
        throw new CarrierError("easypost", "upstream", "purchase returned no label");
      const pdf = await fetch(labelUrl, { signal: AbortSignal.timeout(30_000) });
      if (!pdf.ok) throw new CarrierError("easypost", "upstream", `label download ${pdf.status}`);
      const labelKey = objectKey(req.companyId, "label", "pdf");
      await putObject(labelKey, Buffer.from(await pdf.arrayBuffer()), "application/pdf");
      return {
        trackingCode: bought.tracking_code,
        trackingUrl: bought.tracker?.public_url ?? null,
        labelKey,
        carrierLabelId: bought.postage_label?.id ?? null,
        postageCents: bought.selected_rate
          ? Math.round(Number.parseFloat(bought.selected_rate.rate) * 100)
          : req.rate.rateCents,
      };
    },

    async void({ carrierShipmentId }) {
      const res = await call<EpShipment>(apiKey, `/shipments/${carrierShipmentId}/refund`);
      if (res.refund_status === "rejected" || res.refund_status === "not_applicable")
        return { ok: false, detail: `refund ${res.refund_status}` };
      return { ok: true };
    },
  };
}

export const easypostCarrier: CarrierAdapter | null = env.EASYPOST_API_KEY
  ? createEasypostCarrier(env.EASYPOST_API_KEY)
  : null;
