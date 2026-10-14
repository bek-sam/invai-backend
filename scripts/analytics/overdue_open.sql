-- overdue_open v1 (metrics/definitions/overdue_open.md), one company (wave 55).
-- Orders whose ship_by fell in [from, min(to, now)) and that are still open: status not shipped,
-- delivered or cancelled. One row per order, then 'all' plus one row per channel. Held orders
-- count (on_hold_orders); an order with a unit already shipped counts once (partly_shipped_orders,
-- never on top of on_hold). ship_by is an instant: the shop time zone only places the window ends.
-- "Overdue now" = a far-past from and a to of tomorrow or later. Counts only, no percent.
-- Bound parameters: company_id, from (inclusive date), to (exclusive date), now (instant, or
-- null for the database clock; tests pin it).
WITH c AS (
  SELECT timezone FROM companies WHERE id = :company_id),
w AS (
  SELECT (:from::date::timestamp AT TIME ZONE c.timezone) AS f,
         least((:to::date::timestamp AT TIME ZONE c.timezone),
               coalesce(:now::timestamptz, now())) AS t FROM c),
open_orders AS (
  SELECT o.id, o.channel, o.status
  FROM orders o, w
  WHERE o.company_id = :company_id
    AND o.status NOT IN ('shipped', 'delivered', 'cancelled')
    AND o.ship_by >= w.f AND o.ship_by < w.t),
units AS (
  SELECT i.order_id,
         (count(*) FILTER (WHERE i.state NOT IN ('shipped', 'delivered', 'cancelled')))::int AS open_units,
         bool_or(i.state IN ('shipped', 'delivered')) AS any_shipped
  FROM order_items i
  WHERE i.company_id = :company_id AND i.order_id IN (SELECT id FROM open_orders)
  GROUP BY i.order_id),
per AS (
  SELECT oo.channel, (oo.status = 'on_hold') AS held,
         (oo.status <> 'on_hold' AND coalesce(u.any_shipped, false)) AS partly,
         coalesce(u.open_units, 0) AS open_units
  FROM open_orders oo LEFT JOIN units u ON u.order_id = oo.id),
res AS (
  SELECT 'all' AS channel, count(*)::int AS overdue_orders,
         (count(*) FILTER (WHERE held))::int AS on_hold_orders,
         (count(*) FILTER (WHERE partly))::int AS partly_shipped_orders,
         coalesce(sum(open_units), 0)::int AS open_units
  FROM per
  UNION ALL
  SELECT channel, count(*)::int, (count(*) FILTER (WHERE held))::int,
         (count(*) FILTER (WHERE partly))::int, coalesce(sum(open_units), 0)::int
  FROM per GROUP BY channel)
SELECT channel, overdue_orders, on_hold_orders, partly_shipped_orders, open_units
FROM res ORDER BY (channel <> 'all'), channel
