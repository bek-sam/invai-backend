-- Things drizzle-kit cannot express. Runs as the owner role (invai).
-- Extensions are created by src/db/migrate.ts before this file (needs superuser locally);
-- the CREATE EXTENSION statements below are idempotent no-ops when that already happened.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint

-- The app role: DML on every table, sequences for defaults, and the same for tables created later.
GRANT USAGE ON SCHEMA public TO invai_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO invai_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO invai_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO invai_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO invai_app;--> statement-breakpoint

-- Global tables the app only reads.
REVOKE INSERT, UPDATE, DELETE ON trademark_marks, plans FROM invai_app;--> statement-breakpoint

-- Fuzzy search: SKU mapper, design search, trademark matching.
CREATE INDEX IF NOT EXISTS trademark_marks_normalized_trgm_idx ON trademark_marks USING gin (normalized gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS designs_name_trgm_idx ON designs USING gin (name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS order_items_channel_sku_trgm_idx ON order_items USING gin (channel_sku gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS listing_variants_channel_sku_trgm_idx ON listing_variants USING gin (channel_sku gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS orders_order_no_trgm_idx ON orders USING gin (order_no gin_trgm_ops);--> statement-breakpoint

-- The stock ledger is append-only.
CREATE OR REPLACE FUNCTION inventory_movements_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements is append-only (% not allowed)', TG_OP;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS inventory_movements_append_only ON inventory_movements;--> statement-breakpoint
CREATE TRIGGER inventory_movements_append_only BEFORE UPDATE OR DELETE ON inventory_movements FOR EACH ROW EXECUTE FUNCTION inventory_movements_append_only();--> statement-breakpoint

-- Audit log and transitions are append-only for the app role too.
REVOKE UPDATE, DELETE ON audit_log, order_item_transitions FROM invai_app;
