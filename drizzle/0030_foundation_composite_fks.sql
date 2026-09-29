-- Composite tenant foreign keys (T-22-2, B-30, S-26). Every FK between two tenant tables becomes
-- (company_id, <col>) -> parent(company_id, id): FK checks ignore RLS, so a single-column FK let a
-- row of shop B point at shop A's row. Expand phase: the constraints are added NOT VALID (no full
-- table scan under the lock); 0031 validates them. drizzle emitted the parents' UNIQUE keys after
-- the FKs that need them, so this file is ordered by hand before it was applied anywhere.
-- Nullable references keep their SET NULL semantics on the referencing column only
-- (`ON DELETE SET NULL (<col>)`, PostgreSQL 15+): a plain composite SET NULL would null company_id.
-- drizzle cannot express the column list, so the schema says `.onDelete("set null")` and this file
-- is the truth for the database; `src/db/fk-coverage.test.ts` checks the shape.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- 1. Drop the single-column FKs.
ALTER TABLE "ai_credit_ledger" DROP CONSTRAINT "ai_credit_ledger_ai_job_id_ai_jobs_id_fk";--> statement-breakpoint
ALTER TABLE "assistant_messages" DROP CONSTRAINT "assistant_messages_conversation_id_assistant_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "listing_drafts" DROP CONSTRAINT "listing_drafts_ai_job_id_ai_jobs_id_fk";--> statement-breakpoint
ALTER TABLE "design_files" DROP CONSTRAINT "design_files_design_id_designs_id_fk";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_design_id_designs_id_fk";--> statement-breakpoint
ALTER TABLE "import_runs" DROP CONSTRAINT "import_runs_connection_id_channel_connections_id_fk";--> statement-breakpoint
ALTER TABLE "listing_variants" DROP CONSTRAINT "listing_variants_listing_id_listings_id_fk";--> statement-breakpoint
ALTER TABLE "listings" DROP CONSTRAINT "listings_connection_id_channel_connections_id_fk";--> statement-breakpoint
ALTER TABLE "sku_rules" DROP CONSTRAINT "sku_rules_connection_id_channel_connections_id_fk";--> statement-breakpoint
ALTER TABLE "profit_lines" DROP CONSTRAINT "profit_lines_order_id_orders_id_fk";--> statement-breakpoint
ALTER TABLE "profit_lines" DROP CONSTRAINT "profit_lines_order_item_id_order_items_id_fk";--> statement-breakpoint
ALTER TABLE "refund_events" DROP CONSTRAINT "refund_events_order_id_orders_id_fk";--> statement-breakpoint
ALTER TABLE "refund_events" DROP CONSTRAINT "refund_events_order_item_id_order_items_id_fk";--> statement-breakpoint
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_blank_variant_id_blank_variants_id_fk";--> statement-breakpoint
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_location_id_locations_id_fk";--> statement-breakpoint
ALTER TABLE "purchase_order_lines" DROP CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk";--> statement-breakpoint
ALTER TABLE "purchase_order_lines" DROP CONSTRAINT "purchase_order_lines_blank_variant_id_blank_variants_id_fk";--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" DROP CONSTRAINT "purchase_order_receipts_purchase_order_id_purchase_orders_id_fk";--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" DROP CONSTRAINT "purchase_order_receipts_location_id_locations_id_fk";--> statement-breakpoint
ALTER TABLE "purchase_orders" DROP CONSTRAINT "purchase_orders_location_id_locations_id_fk";--> statement-breakpoint
ALTER TABLE "stock_levels" DROP CONSTRAINT "stock_levels_blank_variant_id_blank_variants_id_fk";--> statement-breakpoint
ALTER TABLE "stock_levels" DROP CONSTRAINT "stock_levels_location_id_locations_id_fk";--> statement-breakpoint
ALTER TABLE "market_design_niches" DROP CONSTRAINT "market_design_niches_design_id_designs_id_fk";--> statement-breakpoint
ALTER TABLE "market_price_snapshots" DROP CONSTRAINT "market_price_snapshots_design_id_designs_id_fk";--> statement-breakpoint
ALTER TABLE "market_recommendations" DROP CONSTRAINT "market_recommendations_design_id_designs_id_fk";--> statement-breakpoint
ALTER TABLE "buyer_pii" DROP CONSTRAINT "buyer_pii_order_id_orders_id_fk";--> statement-breakpoint
ALTER TABLE "order_item_transitions" DROP CONSTRAINT "order_item_transitions_order_item_id_order_items_id_fk";--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_order_id_orders_id_fk";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_connection_id_channel_connections_id_fk";--> statement-breakpoint
ALTER TABLE "item_artwork" DROP CONSTRAINT "item_artwork_order_item_id_order_items_id_fk";--> statement-breakpoint
ALTER TABLE "item_artwork" DROP CONSTRAINT "item_artwork_template_id_personalization_templates_id_fk";--> statement-breakpoint
ALTER TABLE "privacy_requests" DROP CONSTRAINT "privacy_requests_connection_id_channel_connections_id_fk";--> statement-breakpoint
ALTER TABLE "bins" DROP CONSTRAINT "bins_location_id_locations_id_fk";--> statement-breakpoint
ALTER TABLE "bins" DROP CONSTRAINT "bins_order_id_orders_id_fk";--> statement-breakpoint
ALTER TABLE "floor_requests" DROP CONSTRAINT "floor_requests_order_id_orders_id_fk";--> statement-breakpoint
ALTER TABLE "gang_sheet_batches" DROP CONSTRAINT "gang_sheet_batches_vendor_connection_id_vendor_connections_id_fk";--> statement-breakpoint
ALTER TABLE "gang_sheets" DROP CONSTRAINT "gang_sheets_batch_id_gang_sheet_batches_id_fk";--> statement-breakpoint
ALTER TABLE "gang_sheets" DROP CONSTRAINT "gang_sheets_vendor_connection_id_vendor_connections_id_fk";--> statement-breakpoint
ALTER TABLE "reprints" DROP CONSTRAINT "reprints_order_item_id_order_items_id_fk";--> statement-breakpoint
ALTER TABLE "scans" DROP CONSTRAINT "scans_station_id_stations_id_fk";--> statement-breakpoint
ALTER TABLE "scans" DROP CONSTRAINT "scans_transfer_id_transfers_id_fk";--> statement-breakpoint
ALTER TABLE "scans" DROP CONSTRAINT "scans_order_item_id_order_items_id_fk";--> statement-breakpoint
ALTER TABLE "transfers" DROP CONSTRAINT "transfers_gang_sheet_id_gang_sheets_id_fk";--> statement-breakpoint
ALTER TABLE "transfers" DROP CONSTRAINT "transfers_order_item_id_order_items_id_fk";--> statement-breakpoint
ALTER TABLE "labels" DROP CONSTRAINT "labels_shipment_id_shipments_id_fk";--> statement-breakpoint
ALTER TABLE "shipments" DROP CONSTRAINT "shipments_order_id_orders_id_fk";--> statement-breakpoint
ALTER TABLE "shipments" DROP CONSTRAINT "shipments_package_preset_id_package_presets_id_fk";--> statement-breakpoint
ALTER TABLE "station_tokens" DROP CONSTRAINT "station_tokens_station_id_stations_id_fk";--> statement-breakpoint
ALTER TABLE "stations" DROP CONSTRAINT "stations_location_id_locations_id_fk";--> statement-breakpoint

-- 2. The (company_id, id) keys the composite FKs point at.
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "blank_variants" ADD CONSTRAINT "blank_variants_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "personalization_templates" ADD CONSTRAINT "personalization_templates_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "gang_sheet_batches" ADD CONSTRAINT "gang_sheet_batches_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "gang_sheets" ADD CONSTRAINT "gang_sheets_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "package_presets" ADD CONSTRAINT "package_presets_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "vendor_connections" ADD CONSTRAINT "vendor_connections_company_id_id_unique" UNIQUE("company_id","id");--> statement-breakpoint

-- 3. Composite FKs, NOT VALID (validated in 0031).
ALTER TABLE "ai_credit_ledger" ADD CONSTRAINT "ai_credit_ledger_ai_job_id_fk" FOREIGN KEY ("company_id","ai_job_id") REFERENCES "public"."ai_jobs"("company_id","id") ON DELETE SET NULL ("ai_job_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_id_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."assistant_conversations"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_ai_job_id_fk" FOREIGN KEY ("company_id","ai_job_id") REFERENCES "public"."ai_jobs"("company_id","id") ON DELETE SET NULL ("ai_job_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "design_files" ADD CONSTRAINT "design_files_design_id_fk" FOREIGN KEY ("company_id","design_id") REFERENCES "public"."designs"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_design_id_fk" FOREIGN KEY ("company_id","design_id") REFERENCES "public"."designs"("company_id","id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_connection_id_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."channel_connections"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "listing_variants" ADD CONSTRAINT "listing_variants_listing_id_fk" FOREIGN KEY ("company_id","listing_id") REFERENCES "public"."listings"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_connection_id_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."channel_connections"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "sku_rules" ADD CONSTRAINT "sku_rules_connection_id_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."channel_connections"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "profit_lines" ADD CONSTRAINT "profit_lines_order_id_fk" FOREIGN KEY ("company_id","order_id") REFERENCES "public"."orders"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "profit_lines" ADD CONSTRAINT "profit_lines_order_item_id_fk" FOREIGN KEY ("company_id","order_item_id") REFERENCES "public"."order_items"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_order_id_fk" FOREIGN KEY ("company_id","order_id") REFERENCES "public"."orders"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_order_item_id_fk" FOREIGN KEY ("company_id","order_item_id") REFERENCES "public"."order_items"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_blank_variant_id_fk" FOREIGN KEY ("company_id","blank_variant_id") REFERENCES "public"."blank_variants"("company_id","id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_fk" FOREIGN KEY ("company_id","location_id") REFERENCES "public"."locations"("company_id","id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_fk" FOREIGN KEY ("company_id","purchase_order_id") REFERENCES "public"."purchase_orders"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_blank_variant_id_fk" FOREIGN KEY ("company_id","blank_variant_id") REFERENCES "public"."blank_variants"("company_id","id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" ADD CONSTRAINT "purchase_order_receipts_purchase_order_id_fk" FOREIGN KEY ("company_id","purchase_order_id") REFERENCES "public"."purchase_orders"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" ADD CONSTRAINT "purchase_order_receipts_location_id_fk" FOREIGN KEY ("company_id","location_id") REFERENCES "public"."locations"("company_id","id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_location_id_fk" FOREIGN KEY ("company_id","location_id") REFERENCES "public"."locations"("company_id","id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_blank_variant_id_fk" FOREIGN KEY ("company_id","blank_variant_id") REFERENCES "public"."blank_variants"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_location_id_fk" FOREIGN KEY ("company_id","location_id") REFERENCES "public"."locations"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "market_design_niches" ADD CONSTRAINT "market_design_niches_design_id_fk" FOREIGN KEY ("company_id","design_id") REFERENCES "public"."designs"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "market_price_snapshots" ADD CONSTRAINT "market_price_snapshots_design_id_fk" FOREIGN KEY ("company_id","design_id") REFERENCES "public"."designs"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "market_recommendations" ADD CONSTRAINT "market_recommendations_design_id_fk" FOREIGN KEY ("company_id","design_id") REFERENCES "public"."designs"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "buyer_pii" ADD CONSTRAINT "buyer_pii_order_id_fk" FOREIGN KEY ("company_id","order_id") REFERENCES "public"."orders"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "order_item_transitions" ADD CONSTRAINT "order_item_transitions_order_item_id_fk" FOREIGN KEY ("company_id","order_item_id") REFERENCES "public"."order_items"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fk" FOREIGN KEY ("company_id","order_id") REFERENCES "public"."orders"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_connection_id_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."channel_connections"("company_id","id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "item_artwork" ADD CONSTRAINT "item_artwork_order_item_id_fk" FOREIGN KEY ("company_id","order_item_id") REFERENCES "public"."order_items"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "item_artwork" ADD CONSTRAINT "item_artwork_template_id_fk" FOREIGN KEY ("company_id","template_id") REFERENCES "public"."personalization_templates"("company_id","id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_connection_id_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."channel_connections"("company_id","id") ON DELETE SET NULL ("connection_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "bins" ADD CONSTRAINT "bins_location_id_fk" FOREIGN KEY ("company_id","location_id") REFERENCES "public"."locations"("company_id","id") ON DELETE SET NULL ("location_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "bins" ADD CONSTRAINT "bins_order_id_fk" FOREIGN KEY ("company_id","order_id") REFERENCES "public"."orders"("company_id","id") ON DELETE SET NULL ("order_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "floor_requests" ADD CONSTRAINT "floor_requests_order_id_fk" FOREIGN KEY ("company_id","order_id") REFERENCES "public"."orders"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "gang_sheet_batches" ADD CONSTRAINT "gang_sheet_batches_vendor_connection_id_fk" FOREIGN KEY ("company_id","vendor_connection_id") REFERENCES "public"."vendor_connections"("company_id","id") ON DELETE SET NULL ("vendor_connection_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "gang_sheets" ADD CONSTRAINT "gang_sheets_batch_id_fk" FOREIGN KEY ("company_id","batch_id") REFERENCES "public"."gang_sheet_batches"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "gang_sheets" ADD CONSTRAINT "gang_sheets_vendor_connection_id_fk" FOREIGN KEY ("company_id","vendor_connection_id") REFERENCES "public"."vendor_connections"("company_id","id") ON DELETE SET NULL ("vendor_connection_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "reprints" ADD CONSTRAINT "reprints_order_item_id_fk" FOREIGN KEY ("company_id","order_item_id") REFERENCES "public"."order_items"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_station_id_fk" FOREIGN KEY ("company_id","station_id") REFERENCES "public"."stations"("company_id","id") ON DELETE SET NULL ("station_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_transfer_id_fk" FOREIGN KEY ("company_id","transfer_id") REFERENCES "public"."transfers"("company_id","id") ON DELETE SET NULL ("transfer_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_order_item_id_fk" FOREIGN KEY ("company_id","order_item_id") REFERENCES "public"."order_items"("company_id","id") ON DELETE SET NULL ("order_item_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_gang_sheet_id_fk" FOREIGN KEY ("company_id","gang_sheet_id") REFERENCES "public"."gang_sheets"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_order_item_id_fk" FOREIGN KEY ("company_id","order_item_id") REFERENCES "public"."order_items"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_shipment_id_fk" FOREIGN KEY ("company_id","shipment_id") REFERENCES "public"."shipments"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fk" FOREIGN KEY ("company_id","order_id") REFERENCES "public"."orders"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_package_preset_id_fk" FOREIGN KEY ("company_id","package_preset_id") REFERENCES "public"."package_presets"("company_id","id") ON DELETE SET NULL ("package_preset_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "station_tokens" ADD CONSTRAINT "station_tokens_station_id_fk" FOREIGN KEY ("company_id","station_id") REFERENCES "public"."stations"("company_id","id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_location_id_fk" FOREIGN KEY ("company_id","location_id") REFERENCES "public"."locations"("company_id","id") ON DELETE RESTRICT NOT VALID;
