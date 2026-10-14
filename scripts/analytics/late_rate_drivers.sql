-- late_rate v1 with driver cuts (metrics/definitions/late_rate.md), one company (wave 54).
-- Of orders shipped in the window (shipped_at, shop tz; cancelled excluded), the share that
-- shipped after InvAI's ship_by. Row 'all' is the whole window; the other rows are the cuts a
-- shop can act on: channel, personalized, rush, multi_unit, blocked_over_24h (a unit waited
-- more than 24 h in needs_mapping or needs_artwork, from order_item_transitions).
-- Percent only from 30 shipped orders in a row; below that, counts only.
-- Bound parameters: company_id, from (inclusive date), to (exclusive date).
WITH c AS (
  SELECT timezone FROM companies WHERE id = :company_id),
w AS (
  SELECT (:from::date::timestamp AT TIME ZONE c.timezone) AS f,
         (:to::date::timestamp AT TIME ZONE c.timezone) AS t FROM c),
shipped AS (
  SELECT o.id, o.channel, o.has_personalization, o.is_rush, o.item_count > 1 AS multi_unit,
         o.shipped_at > o.ship_by AS late
  FROM orders o, w
  WHERE o.company_id = :company_id AND o.shipped_at >= w.f AND o.shipped_at < w.t
    AND o.status <> 'cancelled'),
blocked AS (
  SELECT DISTINCT tr.order_id
  FROM (SELECT order_id, to_state, created_at,
               lead(created_at) OVER (PARTITION BY order_item_id ORDER BY created_at) AS left_at
        FROM order_item_transitions
        WHERE company_id = :company_id AND order_id IN (SELECT id FROM shipped)) tr
  WHERE tr.to_state IN ('needs_mapping', 'needs_artwork')
    AND coalesce(tr.left_at, now()) - tr.created_at > interval '24 hours'),
cut AS (
  SELECT 'channel' AS driver, s.channel AS value, s.late FROM shipped s
  UNION ALL SELECT 'personalized', s.has_personalization::text, s.late FROM shipped s
  UNION ALL SELECT 'rush', s.is_rush::text, s.late FROM shipped s
  UNION ALL SELECT 'multi_unit', s.multi_unit::text, s.late FROM shipped s
  UNION ALL SELECT 'blocked_over_24h', (b.order_id IS NOT NULL)::text, s.late
            FROM shipped s LEFT JOIN blocked b ON b.order_id = s.id),
res AS (
  SELECT 'all' AS driver, 'all' AS value, count(*)::int AS shipped,
         (count(*) FILTER (WHERE late))::int AS late,
         CASE WHEN count(*) >= 30
              THEN round(100.0 * count(*) FILTER (WHERE late) / count(*), 1)::float8 END AS late_rate_pct
  FROM shipped
  UNION ALL
  SELECT driver, value, count(*)::int, (count(*) FILTER (WHERE late))::int,
         CASE WHEN count(*) >= 30
              THEN round(100.0 * count(*) FILTER (WHERE late) / count(*), 1)::float8 END
  FROM cut GROUP BY driver, value)
SELECT driver, value, shipped, late, late_rate_pct
FROM res ORDER BY (driver <> 'all'), driver, value
