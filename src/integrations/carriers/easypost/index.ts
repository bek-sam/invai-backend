import type { Address } from "../../../db/schema";
import { env } from "../../../env";
import { logger } from "../../../lib/log";
import { putObject } from "../../../lib/s3";
import { type EpTracker, normalizeEasypostTracker, type TrackingAdapter } from "../tracking";
import {
  type AddressCheck,
  type CarrierAdapter,
  type CarrierCode,
  CarrierError,
  type CarrierExtras,
  type CarrierRate,
  type CarrierScanForm,
  labelObjectKey,
  type PurchasedLabel,
  scanFormObjectKey,
} from "../types";

/*
 * EasyPost REST adapter (https://docs.easypost.com/docs/shipments). No SDK: plain fetch with
 * HTTP Basic auth (the API key as the username).
 *   POST /v2/shipments               create with from/to/parcel -> rates[]
 *   POST /v2/shipments/{id}/buy      { rate: { id } } -> tracking_code, postage_label, tracker
 *   GET  /v2/shipments/{id}          read-back before any retry (postage_label, refund_status)
 *   POST /v2/shipments/{id}/refund   -> refund_status (submitted | refunded | rejected)
 *   GET  /v2/trackers/{id}           tracker status + scan history (daily fallback poll)
 *   POST /v2/trackers                create, or get back the existing tracker for the code
 *   POST /v2/addresses               { address, verify: true } -> verifications.delivery
 *                                    (https://docs.easypost.com/docs/addresses; checked 2026-09-29)
 *   POST /v2/scan_forms              { shipments: [{ id }] } -> sf_..., status creating|created|
 *                                    failed, form_url (https://docs.easypost.com/docs/scan-form;
 *                                    checked 2026-09-29). Same origin address, same carrier
 *                                    account; a shipment goes on one form only and forms are
 *                                    immutable, so a repeat reads back `scan_form` on the shipment.
 * Errors (https://docs.easypost.com/guides/errors-guide): only rate codes that mean "fetch new
 * rates" map to `rate_expired`. 429 has no Retry-After (rate-limiting guide): reads back off
 * with jitter; a buy or refund is never re-sent automatically.
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
  tracker?: (EpTracker & { public_url?: string | null }) | null;
  refund_status?: string | null;
  messages?: { carrier: string; message: string }[];
  scan_form?: EpScanForm | null;
};
type EpScanForm = {
  id: string;
  status?: string | null;
  form_url?: string | null;
  message?: string | null;
};
type EpAddress = {
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  verifications?: {
    delivery?: { success?: boolean; errors?: { code?: string; message?: string }[] } | null;
  } | null;
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

/** Rate codes that mean "these rates can't be bought any more: fetch new ones". */
export const RATE_EXPIRED_CODES = new Set([
  "SHIPMENT.RATE.EXPIRED",
  "SHIPMENT.RATE.CARRIER_ACCOUNT_INVALID",
  "ORDER.RATE.UNAVAILABLE",
]);
/** The carrier may have acted (or already had): the caller reads back before any retry. */
const OUTCOME_UNKNOWN_CODES = new Set([
  "SHIPMENT.POSTAGE.NO_RESPONSE",
  "SHIPMENT.POSTAGE.TIMED_OUT",
  "SHIPMENT.POSTAGE.EXISTS",
]);

/** Map an EasyPost error response to a CarrierError. */
export function easypostError(status: number, code: string, message: string): CarrierError {
  if (status === 429)
    return new CarrierError(
      "easypost",
      "upstream",
      "EasyPost is limiting requests right now (RATE_LIMITED). Try again in a minute.",
      "not_done",
    );
  if (code.includes("ADDRESS")) return new CarrierError("easypost", "address_invalid", message);
  if (RATE_EXPIRED_CODES.has(code)) return new CarrierError("easypost", "rate_expired", message);
  return new CarrierError(
    "easypost",
    "upstream",
    `${code}: ${message}`,
    status >= 500 || OUTCOME_UNKNOWN_CODES.has(code) ? "unknown" : "not_done",
  );
}

/** Backoff for 429 on requests that are safe to send again: exponential with full jitter. */
export const RETRY_429 = { attempts: 3, baseMs: 500 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(
  apiKey: string,
  path: string,
  body?: unknown,
  method: "GET" | "POST" = "POST",
  /** Only for requests that charge nothing and change nothing when repeated. */
  retry429 = method === "GET",
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // A timeout or network error leaves the outcome unknown: the caller reads back before retrying.
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: authHeader(apiKey), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((err) => {
      throw new CarrierError("easypost", "upstream", String(err), "unknown");
    });
    if (res.status === 429 && retry429 && attempt < RETRY_429.attempts) {
      await res.body?.cancel().catch(() => {});
      await sleep(Math.random() * RETRY_429.baseMs * 2 ** attempt);
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as T & EpError;
    if (!res.ok) {
      const code = json.error?.code ?? String(res.status);
      const message = json.error?.message ?? `HTTP ${res.status}`;
      log.warn("easypost error", { path, status: res.status, code, message });
      throw easypostError(res.status, code, message);
    }
    return json;
  }
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

/**
 * EasyPost makes a tracker when a shipment is bought (its tracker.updated events drive the
 * shipment's state). If the buy response has none, create it: EasyPost returns the existing one
 * for the same code and carrier. Best effort: the label is bought either way, and the daily poll
 * creates it later if this fails.
 */
async function ensureTracker(apiKey: string, bought: EpShipment, carrier: string) {
  if (bought.tracker?.id || !bought.tracking_code) return;
  try {
    const t = await call<EpTracker>(
      apiKey,
      "/trackers",
      { tracker: { tracking_code: bought.tracking_code, carrier: carrier.toUpperCase() } },
      "POST",
      true,
    );
    log.info("easypost tracker created after buy", { shipmentId: bought.id, trackerId: t.id });
  } catch (err) {
    log.warn("easypost tracker not created; the daily poll retries", {
      shipmentId: bought.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** SCAN form PDFs come from EasyPost's own file hosts (research 12 §1.7: allowlisted hosts only). */
export function isEasypostFileUrl(raw: string) {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    return (
      u.protocol === "https:" &&
      (h === "easypost.com" ||
        h.endsWith(".easypost.com") ||
        (h.startsWith("easypost-files.") && h.endsWith(".amazonaws.com")))
    );
  } catch {
    return false;
  }
}

const FORM_MAX_BYTES = 10 * 1024 * 1024;

/** Copy a finished SCAN form PDF into our bucket; null while EasyPost is still rendering it. */
async function storeScanForm(
  companyId: string,
  formId: string,
  form: EpScanForm,
): Promise<string | null> {
  if (!form.form_url) return null;
  if (!isEasypostFileUrl(form.form_url)) {
    log.warn("easypost scan form url on an unexpected host; not downloaded", {
      scanFormId: form.id,
      host: new URL(form.form_url).hostname,
    });
    return null;
  }
  const res = await fetch(form.form_url, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  }).catch((err) => {
    throw new CarrierError("easypost", "upstream", `scan form download: ${String(err)}`, "unknown");
  });
  const size = Number(res.headers.get("content-length") ?? 0);
  if (!res.ok || size > FORM_MAX_BYTES) {
    await res.body?.cancel().catch(() => {});
    log.warn("easypost scan form download refused", { scanFormId: form.id, status: res.status });
    return null;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > FORM_MAX_BYTES) return null;
  const key = scanFormObjectKey(companyId, formId);
  await putObject(key, bytes, "application/pdf");
  return key;
}

function toCarrierScanForm(form: EpScanForm, fileKey: string | null): CarrierScanForm {
  return {
    carrierFormId: form.id,
    status: form.status === "created" && fileKey ? "created" : "creating",
    fileKey,
  };
}

const norm = (v: string | null | undefined) =>
  (v ?? "").toUpperCase().replace(/[.,#]/g, "").replace(/\s+/g, " ").trim();

/**
 * Map EasyPost's delivery verification to our three results. A ZIP+4 added to a matching
 * address is still `verified`; any other change is `corrected` with EasyPost's standardized
 * fields (the name, company, phone and email stay the order's own).
 */
export function toAddressCheck(input: Address, ep: EpAddress): AddressCheck {
  const delivery = ep.verifications?.delivery;
  if (!delivery?.success) {
    const detail =
      (delivery?.errors ?? [])
        .map((e) => e.message)
        .filter(Boolean)
        .join("; ")
        .slice(0, 200) || "Address not found";
    return { status: "failed", suggestion: null, detail };
  }
  const suggestion: Address = {
    ...input,
    street1: ep.street1 ?? input.street1,
    street2: ep.street2 ? ep.street2 : null,
    city: ep.city ?? input.city,
    state: ep.state ?? input.state,
    zip: ep.zip ?? input.zip,
    country: ep.country ?? input.country,
  };
  const same =
    norm(suggestion.street1) === norm(input.street1) &&
    norm(suggestion.street2) === norm(input.street2) &&
    norm(suggestion.city) === norm(input.city) &&
    norm(suggestion.state) === norm(input.state) &&
    norm(suggestion.zip).slice(0, 5) === norm(input.zip).slice(0, 5);
  return same
    ? { status: "verified", suggestion: null, detail: null }
    : { status: "corrected", suggestion, detail: null };
}

export function createEasypostCarrier(apiKey: string): CarrierAdapter & CarrierExtras {
  return {
    provider: "easypost",

    async rate(req) {
      // Creating a shipment charges nothing, so a 429 is retried with backoff.
      const shipment = await call<EpShipment>(
        apiKey,
        "/shipments",
        {
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
        },
        "POST",
        true,
      );
      const all = shipment.rates ?? [];
      const rates = all.map(toRate).filter((r): r is CarrierRate => !!r);
      // Carriers we can't store a label for yet are named, not dropped silently. The shipping
      // service then filters what's left by the shop's allowed carriers.
      const unsupported = [...new Set(all.filter((r) => !toRate(r)).map((r) => r.carrier))];
      if (unsupported.length)
        log.info("easypost rates skipped: carrier not supported", {
          shipmentId: req.shipmentId,
          carriers: unsupported,
        });
      if (!rates.length) {
        const why =
          shipment.messages?.map((m) => m.message).join("; ") ||
          (unsupported.length
            ? `no USPS or UPS rates (EasyPost offered ${unsupported.join(", ")}, not supported yet)`
            : "no rates returned");
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
      await ensureTracker(apiKey, bought, req.rate.carrier);
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

    async verifyAddress({ address }) {
      // Creating an address charges nothing, so a 429 is retried with backoff.
      const ep = await call<EpAddress>(
        apiKey,
        "/addresses",
        { address: epAddress(address), verify: true },
        "POST",
        true,
      );
      return toAddressCheck(address, ep);
    },

    async createScanForm({ companyId, formId, carrierShipmentIds }) {
      // Never re-sent automatically: a shipment can be on one form only (read back instead).
      const form = await call<EpScanForm>(apiKey, "/scan_forms", {
        shipments: carrierShipmentIds.map((id) => ({ id })),
      });
      if (form.status === "failed")
        throw new CarrierError(
          "easypost",
          "upstream",
          form.message || "SCAN form failed",
          "not_done",
        );
      return toCarrierScanForm(form, await storeScanForm(companyId, formId, form));
    },

    async scanFormOf({ companyId, formId, carrierShipmentId }) {
      const shipment = await call<EpShipment>(
        apiKey,
        `/shipments/${carrierShipmentId}`,
        undefined,
        "GET",
      );
      const form = shipment.scan_form;
      if (!form?.id) return null;
      // The shipment embeds the form; fetch it for the current status and file URL.
      const fresh = await call<EpScanForm>(apiKey, `/scan_forms/${form.id}`, undefined, "GET");
      if (fresh.status === "failed") return null;
      return toCarrierScanForm(fresh, await storeScanForm(companyId, formId, fresh));
    },
  };
}

/**
 * Tracker reads for the fallback poll. Uses the tracker EasyPost made when the label was bought
 * (on the shipment); if there is none, creates one, which EasyPost dedupes per code and carrier.
 */
export function createEasypostTracking(apiKey: string): TrackingAdapter {
  return {
    provider: "easypost",
    async track({ carrierShipmentId, trackingCode, carrier }) {
      const shipment = await call<EpShipment>(
        apiKey,
        `/shipments/${carrierShipmentId}`,
        undefined,
        "GET",
      );
      const known = shipment.tracker?.id
        ? await call<EpTracker>(apiKey, `/trackers/${shipment.tracker.id}`, undefined, "GET")
        : await call<EpTracker>(
            apiKey,
            "/trackers",
            {
              tracker: {
                tracking_code: shipment.tracking_code ?? trackingCode,
                ...(carrier ? { carrier: carrier.toUpperCase() } : {}),
              },
            },
            "POST",
            true,
          );
      const update = normalizeEasypostTracker(known);
      return update && { ...update, carrierShipmentId: update.carrierShipmentId ?? shipment.id };
    },
  };
}

export const easypostTracking: TrackingAdapter | null = env.EASYPOST_API_KEY
  ? createEasypostTracking(env.EASYPOST_API_KEY)
  : null;

export const easypostCarrier: (CarrierAdapter & CarrierExtras) | null = env.EASYPOST_API_KEY
  ? createEasypostCarrier(env.EASYPOST_API_KEY)
  : null;
