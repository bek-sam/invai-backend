-- contribution_margin v1 (metrics/definitions/contribution_margin.md), one company (wave 54).
-- CM1 = revenue - channel fees + fees recovered on refunds - blank - transfer
-- CM2 = CM1 - label - packaging - labor - cancel reversals on the line - refund events
-- CM3 = CM2 - ads (= the Profit page's Net, recomputed from the cost buckets, never net_cents)
-- Window: profit lines by placed_at, refund events by refunded_at (same rule as getProfit), shop tz.
-- Rows: one per channel plus 'all'. units = lines that are not cancel reversals. Orders placed
-- in the window that have items but no profit line are counted, not dropped.
-- Percent only from 30 units in a row; below that, cents and counts only.
-- Bound parameters: company_id, from (inclusive date), to (exclusive date).
WITH c AS (
  SELECT timezone FROM companies WHERE id = :company_id),
w AS (
  SELECT (:from::date::timestamp AT TIME ZONE c.timezone) AS f,
         (:to::date::timestamp AT TIME ZONE c.timezone) AS t FROM c),
facts AS (
  SELECT 'line' AS kind, pl.channel, pl.order_id,
    pl.revenue_cents AS revenue, pl.channel_fees_cents AS fees,
    pl.blank_cost_cents + pl.transfer_cost_cents AS cogs,
    pl.label_cost_cents + pl.packaging_cost_cents + pl.labor_cost_cents AS fulfil,
    pl.refunds_cents AS cancel_refunds, pl.ads_cost_cents AS ads,
    0 AS ref_amount, 0 AS ref_recovered,
    CASE WHEN pl.refunds_cents = 0 THEN 1 ELSE 0 END AS unit,
    CASE WHEN pl.refunds_cents = 0
          AND pl.estimated && array['blankCost', 'transferCost', 'labelCost', 'adsCost']::text[]
         THEN 1 ELSE 0 END AS est_unit
  FROM profit_lines pl, w
  WHERE pl.company_id = :company_id AND pl.placed_at >= w.f AND pl.placed_at < w.t
  UNION ALL
  SELECT 'refund', r.channel, r.order_id, 0, 0, 0, 0, 0, 0, r.amount_cents, r.fee_recovered_cents, 0, 0
  FROM refund_events r, w
  WHERE r.company_id = :company_id AND r.voided_at IS NULL
    AND r.refunded_at >= w.f AND r.refunded_at < w.t
  UNION ALL
  SELECT 'noline', o.channel, o.id, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
  FROM orders o, w
  WHERE o.company_id = :company_id AND o.placed_at >= w.f AND o.placed_at < w.t
    AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.company_id = :company_id AND oi.order_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM profit_lines p2 WHERE p2.company_id = :company_id AND p2.order_id = o.id)),
agg AS (
  SELECT coalesce(channel, 'all') AS channel,
    (count(DISTINCT order_id) FILTER (WHERE kind = 'line'))::int AS orders,
    coalesce(sum(unit), 0)::int AS units,
    coalesce(sum(est_unit), 0)::int AS estimated_units,
    (count(DISTINCT order_id) FILTER (WHERE kind = 'noline'))::int AS orders_without_profit_line,
    coalesce(sum(revenue), 0)::bigint AS revenue_cents,
    coalesce(sum(revenue) - sum(fees) + sum(ref_recovered) - sum(cogs), 0)::bigint AS cm1_cents,
    coalesce(sum(revenue) - sum(fees) + sum(ref_recovered) - sum(cogs)
             - sum(fulfil) - sum(cancel_refunds) - sum(ref_amount), 0)::bigint AS cm2_cents,
    coalesce(sum(revenue) - sum(fees) + sum(ref_recovered) - sum(cogs)
             - sum(fulfil) - sum(cancel_refunds) - sum(ref_amount) - sum(ads), 0)::bigint AS cm3_cents
  FROM facts GROUP BY GROUPING SETS ((channel), ()))
SELECT channel, orders, units, estimated_units, orders_without_profit_line, revenue_cents,
  cm1_cents, cm2_cents, cm3_cents,
  CASE WHEN units >= 30 AND revenue_cents <> 0
       THEN round(100.0 * cm3_cents / revenue_cents, 1)::float8 END AS cm3_pct,
  CASE WHEN orders > 0 THEN floor(cm3_cents::numeric / orders + 0.5)::bigint END AS profit_per_order_cents
FROM agg ORDER BY (channel <> 'all'), channel
