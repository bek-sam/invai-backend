-- B-164 (T-22-5): the contracts' TikTok Shop referral default moved 8 -> 6 (0.8.0). Saved cost
-- settings were seeded from the old default; left at 8 they no longer match the default, so
-- finance would treat them as a shop override (flat 8%) instead of the verified 6% schedule.
-- One row per company, so this runs inline. Only the tiktok entry at exactly 8 changes; the
-- entry order and every other channel stay as they are.
UPDATE "cost_settings" AS cs
SET "fee_tables" = (
  SELECT jsonb_agg(
    CASE
      WHEN e ->> 'channel' = 'tiktok' AND (e ->> 'transactionPct')::numeric = 8
        THEN jsonb_set(e, '{transactionPct}', '6'::jsonb)
      ELSE e
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(cs."fee_tables") WITH ORDINALITY AS x(e, ord)
),
"updated_at" = now()
WHERE cs."fee_tables" @> '[{"channel": "tiktok", "transactionPct": 8}]'::jsonb;
