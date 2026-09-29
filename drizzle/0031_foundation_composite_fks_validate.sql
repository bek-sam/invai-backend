-- Validate the composite tenant FKs added NOT VALID in 0030 (T-22-2, B-30). VALIDATE takes only
-- SHARE UPDATE EXCLUSIVE on the child (writes continue) and scans it; a real cross-tenant row makes
-- the whole run fail and roll back: report the rows (ids only), never delete or weaken (architect A6).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "ai_credit_ledger" VALIDATE CONSTRAINT "ai_credit_ledger_ai_job_id_fk";--> statement-breakpoint
ALTER TABLE "assistant_messages" VALIDATE CONSTRAINT "assistant_messages_conversation_id_fk";--> statement-breakpoint
ALTER TABLE "listing_drafts" VALIDATE CONSTRAINT "listing_drafts_ai_job_id_fk";--> statement-breakpoint
ALTER TABLE "design_files" VALIDATE CONSTRAINT "design_files_design_id_fk";--> statement-breakpoint
ALTER TABLE "products" VALIDATE CONSTRAINT "products_design_id_fk";--> statement-breakpoint
ALTER TABLE "import_runs" VALIDATE CONSTRAINT "import_runs_connection_id_fk";--> statement-breakpoint
ALTER TABLE "listing_variants" VALIDATE CONSTRAINT "listing_variants_listing_id_fk";--> statement-breakpoint
ALTER TABLE "listings" VALIDATE CONSTRAINT "listings_connection_id_fk";--> statement-breakpoint
ALTER TABLE "sku_rules" VALIDATE CONSTRAINT "sku_rules_connection_id_fk";--> statement-breakpoint
ALTER TABLE "profit_lines" VALIDATE CONSTRAINT "profit_lines_order_id_fk";--> statement-breakpoint
ALTER TABLE "profit_lines" VALIDATE CONSTRAINT "profit_lines_order_item_id_fk";--> statement-breakpoint
ALTER TABLE "refund_events" VALIDATE CONSTRAINT "refund_events_order_id_fk";--> statement-breakpoint
ALTER TABLE "refund_events" VALIDATE CONSTRAINT "refund_events_order_item_id_fk";--> statement-breakpoint
ALTER TABLE "inventory_movements" VALIDATE CONSTRAINT "inventory_movements_blank_variant_id_fk";--> statement-breakpoint
ALTER TABLE "inventory_movements" VALIDATE CONSTRAINT "inventory_movements_location_id_fk";--> statement-breakpoint
ALTER TABLE "purchase_order_lines" VALIDATE CONSTRAINT "purchase_order_lines_purchase_order_id_fk";--> statement-breakpoint
ALTER TABLE "purchase_order_lines" VALIDATE CONSTRAINT "purchase_order_lines_blank_variant_id_fk";--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" VALIDATE CONSTRAINT "purchase_order_receipts_purchase_order_id_fk";--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" VALIDATE CONSTRAINT "purchase_order_receipts_location_id_fk";--> statement-breakpoint
ALTER TABLE "purchase_orders" VALIDATE CONSTRAINT "purchase_orders_location_id_fk";--> statement-breakpoint
ALTER TABLE "stock_levels" VALIDATE CONSTRAINT "stock_levels_blank_variant_id_fk";--> statement-breakpoint
ALTER TABLE "stock_levels" VALIDATE CONSTRAINT "stock_levels_location_id_fk";--> statement-breakpoint
ALTER TABLE "market_design_niches" VALIDATE CONSTRAINT "market_design_niches_design_id_fk";--> statement-breakpoint
ALTER TABLE "market_price_snapshots" VALIDATE CONSTRAINT "market_price_snapshots_design_id_fk";--> statement-breakpoint
ALTER TABLE "market_recommendations" VALIDATE CONSTRAINT "market_recommendations_design_id_fk";--> statement-breakpoint
ALTER TABLE "buyer_pii" VALIDATE CONSTRAINT "buyer_pii_order_id_fk";--> statement-breakpoint
ALTER TABLE "order_item_transitions" VALIDATE CONSTRAINT "order_item_transitions_order_item_id_fk";--> statement-breakpoint
ALTER TABLE "order_items" VALIDATE CONSTRAINT "order_items_order_id_fk";--> statement-breakpoint
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_connection_id_fk";--> statement-breakpoint
ALTER TABLE "item_artwork" VALIDATE CONSTRAINT "item_artwork_order_item_id_fk";--> statement-breakpoint
ALTER TABLE "item_artwork" VALIDATE CONSTRAINT "item_artwork_template_id_fk";--> statement-breakpoint
ALTER TABLE "privacy_requests" VALIDATE CONSTRAINT "privacy_requests_connection_id_fk";--> statement-breakpoint
ALTER TABLE "bins" VALIDATE CONSTRAINT "bins_location_id_fk";--> statement-breakpoint
ALTER TABLE "bins" VALIDATE CONSTRAINT "bins_order_id_fk";--> statement-breakpoint
ALTER TABLE "floor_requests" VALIDATE CONSTRAINT "floor_requests_order_id_fk";--> statement-breakpoint
ALTER TABLE "gang_sheet_batches" VALIDATE CONSTRAINT "gang_sheet_batches_vendor_connection_id_fk";--> statement-breakpoint
ALTER TABLE "gang_sheets" VALIDATE CONSTRAINT "gang_sheets_batch_id_fk";--> statement-breakpoint
ALTER TABLE "gang_sheets" VALIDATE CONSTRAINT "gang_sheets_vendor_connection_id_fk";--> statement-breakpoint
ALTER TABLE "reprints" VALIDATE CONSTRAINT "reprints_order_item_id_fk";--> statement-breakpoint
ALTER TABLE "scans" VALIDATE CONSTRAINT "scans_station_id_fk";--> statement-breakpoint
ALTER TABLE "scans" VALIDATE CONSTRAINT "scans_transfer_id_fk";--> statement-breakpoint
ALTER TABLE "scans" VALIDATE CONSTRAINT "scans_order_item_id_fk";--> statement-breakpoint
ALTER TABLE "transfers" VALIDATE CONSTRAINT "transfers_gang_sheet_id_fk";--> statement-breakpoint
ALTER TABLE "transfers" VALIDATE CONSTRAINT "transfers_order_item_id_fk";--> statement-breakpoint
ALTER TABLE "labels" VALIDATE CONSTRAINT "labels_shipment_id_fk";--> statement-breakpoint
ALTER TABLE "shipments" VALIDATE CONSTRAINT "shipments_order_id_fk";--> statement-breakpoint
ALTER TABLE "shipments" VALIDATE CONSTRAINT "shipments_package_preset_id_fk";--> statement-breakpoint
ALTER TABLE "station_tokens" VALIDATE CONSTRAINT "station_tokens_station_id_fk";--> statement-breakpoint
ALTER TABLE "stations" VALIDATE CONSTRAINT "stations_location_id_fk";
