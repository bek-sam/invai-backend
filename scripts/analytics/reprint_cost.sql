-- reprint_cost v1 (metrics/definitions/reprint_cost.md), one company (wave 54).
-- Reprints requested in the window (requested_at, shop tz; cancelled excluded), by reason, with
-- the estimated cost: the item's transfer cost split over its prints, plus the blank when
-- blank_consumed (same rule as fulfillmentHealth). Rate = reprints / distinct items that
-- reached 'pressed' in the same window. Row 'all' is the total and is always present.
-- Percent only from 30 items pressed; below that, counts and cents only.
-- Bound parameters: company_id, from (inclusive date), to (exclusive date).
WITH c AS (
  SELECT timezone FROM companies WHERE id = :company_id),
w AS (
  SELECT (:from::date::timestamp AT TIME ZONE c.timezone) AS f,
         (:to::date::timestamp AT TIME ZONE c.timezone) AS t FROM c),
pressed AS (
  SELECT count(DISTINCT tr.order_item_id)::int AS n
  FROM order_item_transitions tr, w
  WHERE tr.company_id = :company_id AND tr.to_state = 'pressed'
    AND tr.created_at >= w.f AND tr.created_at < w.t),
rp AS (
  SELECT r.reason,
    (CASE WHEN r.blank_consumed THEN coalesce(pl.blank_cost_cents, 0) ELSE 0 END
     + coalesce(pl.transfer_cost_cents, 0) / (1 + (SELECT count(*) FROM reprints r2
         WHERE r2.company_id = :company_id AND r2.order_item_id = r.order_item_id
           AND r2.status <> 'cancelled')))::int AS cost_cents
  FROM reprints r
  JOIN w ON r.requested_at >= w.f AND r.requested_at < w.t
  LEFT JOIN profit_lines pl ON pl.company_id = :company_id AND pl.order_item_id = r.order_item_id
  WHERE r.company_id = :company_id AND r.status <> 'cancelled'),
res AS (
  SELECT 'all' AS reason, count(*)::int AS reprints, (SELECT n FROM pressed) AS items_pressed,
         CASE WHEN (SELECT n FROM pressed) >= 30
              THEN round(100.0 * count(*) / (SELECT n FROM pressed), 1)::float8 END AS rate_pct,
         coalesce(sum(cost_cents), 0)::bigint AS cost_cents
  FROM rp
  UNION ALL
  SELECT reason, count(*)::int, (SELECT n FROM pressed),
         CASE WHEN (SELECT n FROM pressed) >= 30
              THEN round(100.0 * count(*) / (SELECT n FROM pressed), 1)::float8 END,
         coalesce(sum(cost_cents), 0)::bigint
  FROM rp GROUP BY reason)
SELECT reason, reprints, items_pressed, rate_pct, cost_cents
FROM res ORDER BY (reason <> 'all'), reason
