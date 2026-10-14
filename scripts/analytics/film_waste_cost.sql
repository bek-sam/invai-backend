-- film_waste_cost v1 and film_use (metrics/definitions/film_waste_cost.md), one company (wave 54).
-- Sheets that went to the vendor (sent or later), by sheet created_at, shop tz.
-- film_waste_cents = sum(cost_cents x (1 - utilization)); film_use_pct = length-weighted fill.
-- Always one row. Percent only from 10 sheets; below that, counts and cents only.
-- Bound parameters: company_id, from (inclusive date), to (exclusive date).
WITH c AS (
  SELECT timezone FROM companies WHERE id = :company_id),
w AS (
  SELECT (:from::date::timestamp AT TIME ZONE c.timezone) AS f,
         (:to::date::timestamp AT TIME ZONE c.timezone) AS t FROM c)
SELECT count(g.id)::int AS sheets,
  coalesce(sum(g.cost_cents), 0)::bigint AS film_cost_cents,
  round(coalesce(sum(g.cost_cents * (1 - g.utilization)), 0))::bigint AS film_waste_cents,
  CASE WHEN count(g.id) >= 10
       THEN round((100 * sum(g.utilization * g.length_in) / nullif(sum(g.length_in), 0))::numeric, 1)::float8
  END AS film_use_pct,
  (count(g.id) FILTER (WHERE g.cost_cents = 0))::int AS sheets_without_cost
FROM w LEFT JOIN gang_sheets g ON g.company_id = :company_id
  AND g.created_at >= w.f AND g.created_at < w.t
  AND g.status IN ('sent', 'acknowledged', 'printing', 'printed', 'shipped', 'received')
