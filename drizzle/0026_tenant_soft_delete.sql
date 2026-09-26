ALTER TABLE "companies" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
-- The stock ledger stays append-only, with one exception: the tenant hard purge (B-23, privacy
-- module) may DELETE one company's rows, on the owner connection only, inside a transaction that
-- named that company in the transaction-local `app.purge_company_id`. The app role never can.
CREATE OR REPLACE FUNCTION inventory_movements_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_user <> 'invai_app'
    AND OLD.company_id::text = current_setting('app.purge_company_id', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'inventory_movements is append-only (% not allowed)', TG_OP;
END;
$$;
