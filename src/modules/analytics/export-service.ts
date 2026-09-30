import type { AnalyticsExport, AnalyticsExportInput } from "@invai/contracts";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import { toCsv } from "../../lib/csv";
import { objectKey, putObject } from "../../lib/s3";
import { designLifecycle } from "./design-service";
import * as finance from "./finance-service";
import { inventoryHealth, supplierTrends } from "./inventory-service";
import { getOperations } from "./operations-service";

/*
 * `analytics.export` (T-A5, spec §5, AC-E6): one CSV per view, with that view's own filters, so
 * the file always matches what's on screen. It calls T-A3/T-A4's read services (and this card's
 * own) read-only -- it writes nothing to any table -- and reuses the `finance.exportCsv` file/S3
 * pattern (`modules/finance/service.ts` `exportProfitCsv`). No buyer name, email, address or
 * personalization text is ever a column: every source view already carries only the shop's own
 * ids and numbers.
 */

type Ctx = Pick<TenantContext, "companyId">;

const money = (cents: number | null | undefined): string =>
  cents == null ? "" : (cents / 100).toFixed(2);
const pct = (p: number | null | undefined): string => (p == null ? "" : p.toFixed(1));
const iso = (v: string | null): string => v ?? "";

type Sheet = { headers: string[]; rows: Record<string, unknown>[] };

async function buildSheet(tx: Tx, ctx: Ctx, input: AnalyticsExportInput): Promise<Sheet> {
  switch (input.view) {
    case "unitEconomics": {
      const r = await finance.unitEconomics(tx, ctx, input);
      const headers = [
        "key",
        "label",
        "orders",
        "units",
        "revenue",
        "cm1",
        "cm2",
        "cm3",
        "cm1Pct",
        "cm2Pct",
        "cm3Pct",
        "estimatedShare",
      ];
      const row = (x: { key: string; label: string } & (typeof r.rows)[number]) => ({
        key: x.key,
        label: x.label,
        orders: x.orders,
        units: x.units,
        revenue: money(x.revenue),
        cm1: money(x.cm1),
        cm2: money(x.cm2),
        cm3: money(x.cm3),
        cm1Pct: pct(x.cm1Pct),
        cm2Pct: pct(x.cm2Pct),
        cm3Pct: pct(x.cm3Pct),
        estimatedShare: (x.estimatedShare * 100).toFixed(1),
      });
      return {
        headers,
        rows: [...r.rows.map(row), row({ ...r.totals, key: "TOTAL", label: "Total" })],
      };
    }
    case "losingOrders": {
      const r = await finance.losingOrders(tx, ctx, input);
      return {
        headers: [
          "orderId",
          "orderNo",
          "channel",
          "placedAt",
          "designId",
          "designName",
          "units",
          "revenue",
          "cm2",
          "largestCostLine",
          "largestCostLineCents",
          "estimated",
        ],
        rows: r.orders.map((o) => ({
          ...o,
          revenue: money(o.revenue),
          cm2: money(o.cm2),
          largestCostLineCents: money(o.largestCostLineCents),
        })),
      };
    }
    case "leakage": {
      const r = await finance.leakage(tx, ctx, input);
      return {
        headers: ["component", "cents", "pctOfGross"],
        rows: [
          ...r.waterfall.map((s) => ({
            component: s.component,
            cents: money(s.cents),
            pctOfGross: pct(s.pctOfGross),
          })),
          { component: "remaining", cents: money(r.remaining), pctOfGross: "" },
        ],
      };
    }
    case "shippingMargin": {
      const r = await finance.shippingMargin(tx, ctx, input);
      const headers = [
        "key",
        "label",
        "labeledOrders",
        "charged",
        "labelCost",
        "margin",
        "marginPerOrder",
        "freeShippingOrders",
      ];
      const row = (x: { key: string; label: string } & (typeof r.rows)[number]) => ({
        key: x.key,
        label: x.label,
        labeledOrders: x.labeledOrders,
        charged: money(x.charged),
        labelCost: money(x.labelCost),
        margin: money(x.margin),
        marginPerOrder: money(x.marginPerOrder),
        freeShippingOrders: x.freeShippingOrders,
      });
      return {
        headers,
        rows: [...r.rows.map(row), row({ ...r.totals, key: "TOTAL", label: "Total" })],
      };
    }
    case "profitBridge": {
      const r = await finance.profitBridge(tx, ctx, input);
      return {
        headers: [
          "key",
          "label",
          "baseCm3",
          "currentCm3",
          "change",
          "volumePart",
          "ratePart",
          "baseUnits",
          "currentUnits",
        ],
        rows: r.topMovers.map((m) => ({
          key: m.key,
          label: m.label,
          baseCm3: money(m.baseCm3),
          currentCm3: money(m.currentCm3),
          change: money(m.change),
          volumePart: money(m.volumePart),
          ratePart: money(m.ratePart),
          baseUnits: m.baseUnits,
          currentUnits: m.currentUnits,
        })),
      };
    }
    case "breakEven": {
      const r = await finance.breakEven(tx, ctx, input);
      return {
        headers: [
          "fixedCostsSet",
          "fixedMonthlyCents",
          "orders",
          "cm3",
          "cm3PerOrder",
          "breakEvenOrders",
          "pace",
          "operatingProfitPace",
          "hasEnoughOrders",
        ],
        rows: [
          {
            fixedCostsSet: r.fixedCostsSet,
            fixedMonthlyCents: money(r.fixedMonthlyCents),
            orders: r.orders,
            cm3: money(r.cm3),
            cm3PerOrder: money(r.cm3PerOrder),
            breakEvenOrders: r.breakEvenOrders ?? "",
            pace: r.pace ?? "",
            operatingProfitPace: money(r.operatingProfitPace),
            hasEnoughOrders: r.hasEnoughOrders,
          },
        ],
      };
    }
    case "operations": {
      const r = await getOperations(tx, ctx, input);
      const headers = [
        "section",
        "key",
        "label",
        "count",
        "cost",
        "medianHours",
        "p90Hours",
        "stillWaiting",
        "shippedOrders",
        "lateOrders",
        "latePct",
      ];
      const rows: Record<string, unknown>[] = [
        ...r.reprintCost.byReason.map((x) => ({
          section: "reprintByReason",
          key: x.key,
          label: x.label,
          count: x.reprints,
          cost: money(x.cost),
        })),
        ...r.reprintCost.byStation.map((x) => ({
          section: "reprintByStation",
          key: x.key,
          label: x.label,
          count: x.reprints,
          cost: money(x.cost),
        })),
        ...r.reprintCost.byVendor.map((x) => ({
          section: "reprintByVendor",
          key: x.key,
          label: x.label,
          count: x.reprints,
          cost: money(x.cost),
        })),
        ...r.waits.map((w) => ({
          section: "wait",
          key: w.state,
          label: w.state,
          count: w.entries,
          medianHours: w.medianHours ?? "",
          p90Hours: w.p90Hours ?? "",
          stillWaiting: w.stillWaiting,
        })),
        ...r.lateDrivers.rows.map((x) => ({
          section: "lateDriver",
          key: `${x.driver}:${x.value}`,
          label: x.label,
          shippedOrders: x.shippedOrders,
          lateOrders: x.lateOrders,
          latePct: pct(x.latePct),
        })),
      ];
      return { headers, rows };
    }
    case "inventoryHealth": {
      const r = await inventoryHealth(tx, ctx, input);
      const headers = ["blankVariantId", "label", "onHand", "value", "lastConsumedAt"];
      return {
        headers,
        rows: r.deadStock.rows.map((x) => ({
          ...x,
          value: money(x.value),
          lastConsumedAt: iso(x.lastConsumedAt),
        })),
      };
    }
    case "supplierTrends": {
      const r = await supplierTrends(tx, ctx, input);
      return {
        headers: [
          "supplier",
          "supplierName",
          "styleCode",
          "month",
          "purchaseOrders",
          "units",
          "avgUnitCost",
          "medianLeadDays",
        ],
        rows: r.rows.map((x) => ({
          ...x,
          avgUnitCost: money(x.avgUnitCost),
          medianLeadDays: x.medianLeadDays ?? "",
        })),
      };
    }
    case "designLifecycle": {
      const r = await designLifecycle(tx, ctx, input);
      return {
        headers: [
          "designId",
          "designName",
          "stage",
          "units4w",
          "unitsPrior4w",
          "units365d",
          "hasActiveListing",
          "marketTrend",
        ],
        rows: r.rows.map((x) => ({ ...x, marketTrend: x.marketTrend ?? "" })),
      };
    }
    default: {
      const exhaustive: never = input;
      throw new Error(`unknown analytics export view: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function exportAnalyticsCsv(
  tx: Tx,
  ctx: Ctx,
  input: AnalyticsExportInput,
): Promise<AnalyticsExport> {
  const { headers, rows } = await buildSheet(tx, ctx, input);
  const csv = toCsv(rows, headers);
  const key = objectKey(ctx.companyId, "analytics-export", "csv");
  await putObject(key, csv, "text/csv");
  return { key };
}
