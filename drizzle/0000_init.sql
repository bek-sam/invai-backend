CREATE TABLE "ai_credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"credits" integer NOT NULL,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cache_read_tokens" integer,
	"ai_job_id" uuid,
	"ref_type" text,
	"ref_id" uuid,
	"user_id" uuid,
	"period" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_credit_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"model" text,
	"provider" text DEFAULT 'mock' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"error" text,
	"entity_type" text,
	"entity_id" uuid,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assistant_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assistant_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"tool_calls" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "listing_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"connection_id" uuid,
	"product_id" uuid,
	"ai_job_id" uuid,
	"status" text DEFAULT 'generating' NOT NULL,
	"content" jsonb DEFAULT '{"title":"","description":"","tags":[],"bullets":[],"attributes":{},"price":null,"disclosures":[]}'::jsonb NOT NULL,
	"validation" jsonb,
	"trademark" jsonb,
	"mockup_keys" text[] DEFAULT '{}' NOT NULL,
	"model" text,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"brief" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_reason" text,
	"published_listing_id" text,
	"published_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "trademark_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mark" text NOT NULL,
	"normalized" text NOT NULL,
	"owner" text,
	"kind" text DEFAULT 'word' NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"classes" integer[] DEFAULT '{25}' NOT NULL,
	"serial_no" text,
	"source" text DEFAULT 'seed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trademark_marks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plans" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_monthly_cents" integer DEFAULT 0 NOT NULL,
	"orders_per_month" integer,
	"ai_credits_per_month" integer DEFAULT 0 NOT NULL,
	"label_fee_cents" integer DEFAULT 0 NOT NULL,
	"max_users" integer,
	"max_connections" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plan_key" text NOT NULL,
	"status" text DEFAULT 'trialing' NOT NULL,
	"over_limit_behavior" text DEFAULT 'warn' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period" text NOT NULL,
	"orders_imported" integer DEFAULT 0 NOT NULL,
	"labels_bought" integer DEFAULT 0 NOT NULL,
	"label_fees_cents" integer DEFAULT 0 NOT NULL,
	"sheets_built" integer DEFAULT 0 NOT NULL,
	"ai_credits" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "blank_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"brand" text NOT NULL,
	"style" text NOT NULL,
	"style_code" text NOT NULL,
	"style_name" text,
	"color" text NOT NULL,
	"color_code" text NOT NULL,
	"color_hex" text,
	"size" text NOT NULL,
	"size_code" text NOT NULL,
	"sku" text NOT NULL,
	"supplier" text DEFAULT 'ssactivewear' NOT NULL,
	"supplier_sku" text DEFAULT '' NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"weight_oz" double precision DEFAULT 6 NOT NULL,
	"reorder_point" integer,
	"reorder_qty" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blank_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "design_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"placement" text DEFAULT 'front' NOT NULL,
	"file_key" text NOT NULL,
	"preview_key" text,
	"width_in" double precision NOT NULL,
	"height_in" double precision NOT NULL,
	"width_px" integer,
	"height_px" integer,
	"qa_status" text DEFAULT 'pending' NOT NULL,
	"effective_dpi" double precision,
	"qa_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"qa_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"personalization_template_id" uuid,
	"ocr_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "designs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"brand" text NOT NULL,
	"style_code" text NOT NULL,
	"name" text NOT NULL,
	"allowed_color_codes" text[] DEFAULT '{}' NOT NULL,
	"allowed_size_codes" text[] DEFAULT '{}' NOT NULL,
	"default_placements" text[] DEFAULT '{"front"}' NOT NULL,
	"prices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channel_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"mode" text DEFAULT 'csv' NOT NULL,
	"provider" text DEFAULT 'mock' NOT NULL,
	"external_shop_id" text,
	"credentials" text,
	"settings" jsonb DEFAULT '{"autoImport":true,"processingDays":null,"riskWindowHours":24,"pushTracking":true,"pushAvailability":false}'::jsonb NOT NULL,
	"cursor" text,
	"last_webhook_at" timestamp with time zone,
	"last_poll_at" timestamp with time zone,
	"last_import_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"format" text DEFAULT 'generic' NOT NULL,
	"file_key" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"orders_imported" integer DEFAULT 0 NOT NULL,
	"orders_updated" integer DEFAULT 0 NOT NULL,
	"orders_skipped" integer DEFAULT 0 NOT NULL,
	"rows_failed" integer DEFAULT 0 NOT NULL,
	"items_needing_mapping" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"order_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "listing_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"channel_variant_id" text NOT NULL,
	"channel_sku" text,
	"title" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"design_id" uuid,
	"blank_variant_id" uuid,
	"price_cents" integer,
	"quantity_cap" integer,
	"last_pushed_qty" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"channel_listing_id" text NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"url" text,
	"design_id" uuid,
	"product_id" uuid,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sku_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text,
	"pattern_type" text DEFAULT 'exact' NOT NULL,
	"pattern" text NOT NULL,
	"channel" text,
	"connection_id" uuid,
	"target" jsonb DEFAULT '{"kind":"resolve","defaults":{}}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"match_count" integer DEFAULT 0 NOT NULL,
	"last_matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sku_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ad_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"day" date NOT NULL,
	"channel" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"campaign" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_spend" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cost_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fee_tables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transfer_cents_per_sq_in" integer DEFAULT 3 NOT NULL,
	"packaging_per_order_cents" integer DEFAULT 45 NOT NULL,
	"labor_rate_per_hour_cents" integer DEFAULT 1800 NOT NULL,
	"labor_minutes_per_item" double precision DEFAULT 4 NOT NULL,
	"ads_allocation" text DEFAULT 'revenue_share' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profit_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"design_id" uuid,
	"blank_variant_id" uuid,
	"style_code" text,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"channel_fees_cents" integer DEFAULT 0 NOT NULL,
	"blank_cost_cents" integer DEFAULT 0 NOT NULL,
	"transfer_cost_cents" integer DEFAULT 0 NOT NULL,
	"label_cost_cents" integer DEFAULT 0 NOT NULL,
	"packaging_cost_cents" integer DEFAULT 0 NOT NULL,
	"labor_cost_cents" integer DEFAULT 0 NOT NULL,
	"ads_cost_cents" integer DEFAULT 0 NOT NULL,
	"refunds_cents" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"margin_pct" double precision,
	"print_area_sq_in" double precision DEFAULT 0 NOT NULL,
	"labor_minutes" double precision DEFAULT 0 NOT NULL,
	"is_reprint" boolean DEFAULT false NOT NULL,
	"estimated" text[] DEFAULT '{}' NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profit_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"blank_variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_cents" integer,
	"reason" text,
	"ref_type" text,
	"ref_id" uuid,
	"note" text,
	"user_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"velocity_window_days" integer DEFAULT 30 NOT NULL,
	"lead_time_days" integer DEFAULT 3 NOT NULL,
	"safety_days" integer DEFAULT 2 NOT NULL,
	"reserve_on_import" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"blank_variant_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"supplier" text NOT NULL,
	"location_id" uuid NOT NULL,
	"po_no" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"freight_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"supplier_order_id" text,
	"expected_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"blank_variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"available" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_levels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"supplier" text NOT NULL,
	"name" text NOT NULL,
	"account_number" text,
	"api_key" text,
	"free_freight_threshold_cents" integer DEFAULT 20000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "buyer_pii" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"company" text,
	"street1" text,
	"street2" text,
	"city" text,
	"state" text,
	"zip" text,
	"country" text DEFAULT 'US' NOT NULL,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buyer_pii" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "order_item_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"station_id" uuid,
	"reason" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_item_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" integer DEFAULT 1 NOT NULL,
	"unit_no" integer DEFAULT 1 NOT NULL,
	"units_in_line" integer DEFAULT 1 NOT NULL,
	"channel_line_id" text DEFAULT '' NOT NULL,
	"channel_sku" text DEFAULT '' NOT NULL,
	"channel_listing_id" text,
	"title" text DEFAULT '' NOT NULL,
	"variant_title" text,
	"unit_price_cents" integer DEFAULT 0 NOT NULL,
	"personalization" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'imported' NOT NULL,
	"held_from_state" text,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ship_by" timestamp with time zone NOT NULL,
	"is_rush" boolean DEFAULT false NOT NULL,
	"design_id" uuid,
	"product_id" uuid,
	"blank_variant_id" uuid,
	"placement" text,
	"print_width_in" integer,
	"print_height_in" integer,
	"artwork_status" text DEFAULT 'none' NOT NULL,
	"artwork_key" text,
	"artwork_preview_key" text,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_reprint" boolean DEFAULT false NOT NULL,
	"reprint_of_item_id" uuid,
	"transfer_id" uuid,
	"gang_sheet_id" uuid,
	"bin_id" uuid,
	"shipment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"channel_order_id" text NOT NULL,
	"order_no" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"ship_by" timestamp with time zone NOT NULL,
	"is_rush" boolean DEFAULT false NOT NULL,
	"has_personalization" boolean DEFAULT false NOT NULL,
	"shipping_method" text,
	"buyer_note" text,
	"buyer_ref" text,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"shipping_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"hold_reason" text,
	"hold_note" text,
	"held_at" timestamp with time zone,
	"cancel_reason" text,
	"cancel_note" text,
	"cancelled_at" timestamp with time zone,
	"bin_id" uuid,
	"raw_payload_key" text,
	"import_run_id" uuid,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "item_artwork" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_key" text,
	"preview_key" text,
	"width_px" integer,
	"height_px" integer,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"rendered_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_artwork" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "personalization_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"width_in" double precision NOT NULL,
	"height_in" double precision NOT NULL,
	"background_key" text,
	"dpi" integer DEFAULT 300 NOT NULL,
	"slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personalization_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"location_id" uuid,
	"code" text NOT NULL,
	"order_id" uuid,
	"station" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gang_sheet_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"due_before" timestamp with time zone,
	"vendor_connection_id" uuid,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"sheet_count" integer DEFAULT 0 NOT NULL,
	"job_id" uuid,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gang_sheet_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gang_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"sheet_no" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"vendor_connection_id" uuid,
	"width_in" double precision DEFAULT 22 NOT NULL,
	"length_in" double precision DEFAULT 0 NOT NULL,
	"utilization" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"png_key" text,
	"pdf_key" text,
	"preview_key" text,
	"transfer_count" integer DEFAULT 0 NOT NULL,
	"reprint_count" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"tracking_carrier" text,
	"tracking_code" text,
	"vendor_notes" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"printed_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gang_sheets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"original_transfer_id" uuid,
	"new_transfer_id" uuid,
	"blank_consumed" boolean DEFAULT true NOT NULL,
	"station_id" uuid,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"client_scan_id" uuid NOT NULL,
	"station_id" uuid,
	"station" text NOT NULL,
	"action" text NOT NULL,
	"user_id" uuid,
	"transfer_code" text NOT NULL,
	"blank_code" text,
	"transfer_id" uuid,
	"order_item_id" uuid,
	"ok" boolean NOT NULL,
	"mismatch" text,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"gang_sheet_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"x_in" double precision DEFAULT 0 NOT NULL,
	"y_in" double precision DEFAULT 0 NOT NULL,
	"width_in" double precision NOT NULL,
	"height_in" double precision NOT NULL,
	"rotated" boolean DEFAULT false NOT NULL,
	"label" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'placed' NOT NULL,
	"is_reprint" boolean DEFAULT false NOT NULL,
	"scrapped" boolean DEFAULT false NOT NULL,
	"pressed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"carrier" text NOT NULL,
	"service" text NOT NULL,
	"tracking_code" text NOT NULL,
	"label_key" text NOT NULL,
	"format" text DEFAULT 'pdf' NOT NULL,
	"postage_cents" integer NOT NULL,
	"label_fee_cents" integer DEFAULT 0 NOT NULL,
	"carrier_label_id" text,
	"status" text DEFAULT 'purchased' NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "package_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"length_in" double precision NOT NULL,
	"width_in" double precision NOT NULL,
	"height_in" double precision NOT NULL,
	"tare_oz" double precision DEFAULT 0 NOT NULL,
	"max_units" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "package_presets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"carrier" text,
	"service" text,
	"tracking_code" text,
	"tracking_url" text,
	"tracking_status" text,
	"label_key" text,
	"label_format" text,
	"postage_cents" integer DEFAULT 0 NOT NULL,
	"label_fee_cents" integer DEFAULT 0 NOT NULL,
	"package_preset_id" uuid,
	"length_in" double precision DEFAULT 10 NOT NULL,
	"width_in" double precision DEFAULT 8 NOT NULL,
	"height_in" double precision DEFAULT 1 NOT NULL,
	"weight_oz" double precision DEFAULT 6 NOT NULL,
	"rate_quotes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected_rate_id" text,
	"rated_at" timestamp with time zone,
	"carrier_shipment_id" text,
	"carrier_label_id" text,
	"tracking_push_status" text DEFAULT 'pending' NOT NULL,
	"tracking_pushed_at" timestamp with time zone,
	"tracking_push_attempts" integer DEFAULT 0 NOT NULL,
	"tracking_push_error" text,
	"labeled_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shipping_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"from_address" jsonb,
	"weight_per_style" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_strategy" text DEFAULT 'cheapest_on_time' NOT NULL,
	"allowed_carriers" text[] DEFAULT '{"usps","ups","mock"}' NOT NULL,
	"label_format" text DEFAULT 'pdf' NOT NULL,
	"tracking_push_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipping_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"title" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"station_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"summary" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"type" text DEFAULT 'shop' NOT NULL,
	"plan" text DEFAULT 'trial',
	"timezone" text DEFAULT 'America/Phoenix' NOT NULL,
	"demo" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"filename" text,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size_bytes" bigint,
	"sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"inviter_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" double precision DEFAULT 0 NOT NULL,
	"message" text,
	"result_ids" uuid[] DEFAULT '{}' NOT NULL,
	"error" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'office' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"active_organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "staff_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"pin_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_pins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "station_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "station_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text,
	"active" boolean DEFAULT true NOT NULL,
	"token_issued_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_company_id" uuid NOT NULL,
	"gang_sheet_id" uuid NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "vendor_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vendor_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_company_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"delivery" text DEFAULT 'email' NOT NULL,
	"spec" jsonb DEFAULT '{"widthIn":22,"maxLengthIn":240,"format":"png","dpi":300,"pricePerInch":30,"spacingIn":0.25,"marginIn":0.25,"colorProfile":null,"notes":null}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"turnaround_days" integer DEFAULT 2 NOT NULL,
	"invite_token" text,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendor_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_credit_ledger" ADD CONSTRAINT "ai_credit_ledger_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_ledger" ADD CONSTRAINT "ai_credit_ledger_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_key_plans_key_fk" FOREIGN KEY ("plan_key") REFERENCES "public"."plans"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blank_variants" ADD CONSTRAINT "blank_variants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_files" ADD CONSTRAINT "design_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_files" ADD CONSTRAINT "design_files_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_variants" ADD CONSTRAINT "listing_variants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_variants" ADD CONSTRAINT "listing_variants_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_rules" ADD CONSTRAINT "sku_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_rules" ADD CONSTRAINT "sku_rules_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_settings" ADD CONSTRAINT "cost_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_lines" ADD CONSTRAINT "profit_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_lines" ADD CONSTRAINT "profit_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_lines" ADD CONSTRAINT "profit_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_blank_variant_id_blank_variants_id_fk" FOREIGN KEY ("blank_variant_id") REFERENCES "public"."blank_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_blank_variant_id_blank_variants_id_fk" FOREIGN KEY ("blank_variant_id") REFERENCES "public"."blank_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_blank_variant_id_blank_variants_id_fk" FOREIGN KEY ("blank_variant_id") REFERENCES "public"."blank_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_pii" ADD CONSTRAINT "buyer_pii_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_pii" ADD CONSTRAINT "buyer_pii_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_transitions" ADD CONSTRAINT "order_item_transitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_transitions" ADD CONSTRAINT "order_item_transitions_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_artwork" ADD CONSTRAINT "item_artwork_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_artwork" ADD CONSTRAINT "item_artwork_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_artwork" ADD CONSTRAINT "item_artwork_template_id_personalization_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."personalization_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personalization_templates" ADD CONSTRAINT "personalization_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bins" ADD CONSTRAINT "bins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bins" ADD CONSTRAINT "bins_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bins" ADD CONSTRAINT "bins_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gang_sheet_batches" ADD CONSTRAINT "gang_sheet_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gang_sheet_batches" ADD CONSTRAINT "gang_sheet_batches_vendor_connection_id_vendor_connections_id_fk" FOREIGN KEY ("vendor_connection_id") REFERENCES "public"."vendor_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gang_sheets" ADD CONSTRAINT "gang_sheets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gang_sheets" ADD CONSTRAINT "gang_sheets_batch_id_gang_sheet_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."gang_sheet_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gang_sheets" ADD CONSTRAINT "gang_sheets_vendor_connection_id_vendor_connections_id_fk" FOREIGN KEY ("vendor_connection_id") REFERENCES "public"."vendor_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reprints" ADD CONSTRAINT "reprints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reprints" ADD CONSTRAINT "reprints_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_gang_sheet_id_gang_sheets_id_fk" FOREIGN KEY ("gang_sheet_id") REFERENCES "public"."gang_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_presets" ADD CONSTRAINT "package_presets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_package_preset_id_package_presets_id_fk" FOREIGN KEY ("package_preset_id") REFERENCES "public"."package_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_settings" ADD CONSTRAINT "shipping_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_companies_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_organization_id_companies_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_companies_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_tokens" ADD CONSTRAINT "station_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_tokens" ADD CONSTRAINT "station_tokens_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_tokens" ADD CONSTRAINT "station_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_access" ADD CONSTRAINT "vendor_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_access" ADD CONSTRAINT "vendor_access_vendor_company_id_companies_id_fk" FOREIGN KEY ("vendor_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_connections" ADD CONSTRAINT "vendor_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_connections" ADD CONSTRAINT "vendor_connections_vendor_company_id_companies_id_fk" FOREIGN KEY ("vendor_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_credit_ledger_company_id_period_index" ON "ai_credit_ledger" USING btree ("company_id","period");--> statement-breakpoint
CREATE INDEX "ai_credit_ledger_company_id_created_at_index" ON "ai_credit_ledger" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_jobs_company_id_kind_created_at_index" ON "ai_jobs" USING btree ("company_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "ai_jobs_company_id_entity_type_entity_id_index" ON "ai_jobs" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "assistant_conversations_company_id_user_id_updated_at_index" ON "assistant_conversations" USING btree ("company_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "assistant_messages_company_id_conversation_id_created_at_index" ON "assistant_messages" USING btree ("company_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "listing_drafts_company_id_design_id_channel_index" ON "listing_drafts" USING btree ("company_id","design_id","channel");--> statement-breakpoint
CREATE INDEX "listing_drafts_company_id_status_created_at_index" ON "listing_drafts" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trademark_marks_normalized_kind_index" ON "trademark_marks" USING btree ("normalized","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_company_id_index" ON "subscriptions" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_company_id_period_index" ON "usage" USING btree ("company_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "blank_variants_company_id_brand_style_code_color_code_size_code_index" ON "blank_variants" USING btree ("company_id","brand","style_code","color_code","size_code");--> statement-breakpoint
CREATE UNIQUE INDEX "blank_variants_company_id_sku_index" ON "blank_variants" USING btree ("company_id","sku");--> statement-breakpoint
CREATE INDEX "blank_variants_company_id_style_code_index" ON "blank_variants" USING btree ("company_id","style_code");--> statement-breakpoint
CREATE INDEX "blank_variants_company_id_supplier_sku_index" ON "blank_variants" USING btree ("company_id","supplier_sku");--> statement-breakpoint
CREATE UNIQUE INDEX "design_files_company_id_design_id_placement_index" ON "design_files" USING btree ("company_id","design_id","placement");--> statement-breakpoint
CREATE UNIQUE INDEX "designs_company_id_code_index" ON "designs" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "designs_company_id_status_index" ON "designs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "products_company_id_design_id_index" ON "products" USING btree ("company_id","design_id");--> statement-breakpoint
CREATE INDEX "products_company_id_style_code_index" ON "products" USING btree ("company_id","style_code");--> statement-breakpoint
CREATE INDEX "channel_connections_company_id_channel_index" ON "channel_connections" USING btree ("company_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_company_id_channel_external_shop_id_index" ON "channel_connections" USING btree ("company_id","channel","external_shop_id");--> statement-breakpoint
CREATE INDEX "import_runs_company_id_started_at_index" ON "import_runs" USING btree ("company_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_variants_company_id_listing_id_channel_variant_id_index" ON "listing_variants" USING btree ("company_id","listing_id","channel_variant_id");--> statement-breakpoint
CREATE INDEX "listing_variants_company_id_channel_sku_index" ON "listing_variants" USING btree ("company_id","channel_sku");--> statement-breakpoint
CREATE INDEX "listing_variants_company_id_blank_variant_id_index" ON "listing_variants" USING btree ("company_id","blank_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_company_id_connection_id_channel_listing_id_index" ON "listings" USING btree ("company_id","connection_id","channel_listing_id");--> statement-breakpoint
CREATE INDEX "listings_company_id_design_id_index" ON "listings" USING btree ("company_id","design_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_rules_company_id_channel_connection_id_pattern_index" ON "sku_rules" USING btree ("company_id","channel","connection_id","pattern");--> statement-breakpoint
CREATE INDEX "sku_rules_company_id_pattern_type_priority_index" ON "sku_rules" USING btree ("company_id","pattern_type","priority");--> statement-breakpoint
CREATE INDEX "ad_spend_company_id_channel_day_index" ON "ad_spend" USING btree ("company_id","channel","day");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_settings_company_id_index" ON "cost_settings" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profit_lines_company_id_order_item_id_index" ON "profit_lines" USING btree ("company_id","order_item_id");--> statement-breakpoint
CREATE INDEX "profit_lines_company_id_order_id_index" ON "profit_lines" USING btree ("company_id","order_id");--> statement-breakpoint
CREATE INDEX "profit_lines_company_id_design_id_index" ON "profit_lines" USING btree ("company_id","design_id");--> statement-breakpoint
CREATE INDEX "profit_lines_company_id_channel_placed_at_index" ON "profit_lines" USING btree ("company_id","channel","placed_at");--> statement-breakpoint
CREATE INDEX "profit_lines_company_id_style_code_index" ON "profit_lines" USING btree ("company_id","style_code");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_company_id_idempotency_key_index" ON "inventory_movements" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_movements_company_id_blank_variant_id_created_at_index" ON "inventory_movements" USING btree ("company_id","blank_variant_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_company_id_ref_type_ref_id_index" ON "inventory_movements" USING btree ("company_id","ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_company_id_created_at_index" ON "inventory_movements" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_settings_company_id_index" ON "inventory_settings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_company_id_purchase_order_id_index" ON "purchase_order_lines" USING btree ("company_id","purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_company_id_po_no_index" ON "purchase_orders" USING btree ("company_id","po_no");--> statement-breakpoint
CREATE INDEX "purchase_orders_company_id_status_index" ON "purchase_orders" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_levels_company_id_blank_variant_id_location_id_index" ON "stock_levels" USING btree ("company_id","blank_variant_id","location_id");--> statement-breakpoint
CREATE INDEX "stock_levels_company_id_available_index" ON "stock_levels" USING btree ("company_id","available");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_company_id_supplier_index" ON "suppliers" USING btree ("company_id","supplier");--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_pii_company_id_order_id_index" ON "buyer_pii" USING btree ("company_id","order_id");--> statement-breakpoint
CREATE INDEX "buyer_pii_purge_after_index" ON "buyer_pii" USING btree ("purge_after");--> statement-breakpoint
CREATE INDEX "order_item_transitions_company_id_order_item_id_created_at_index" ON "order_item_transitions" USING btree ("company_id","order_item_id","created_at");--> statement-breakpoint
CREATE INDEX "order_item_transitions_company_id_order_id_created_at_index" ON "order_item_transitions" USING btree ("company_id","order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_item_transitions_company_id_created_at_index" ON "order_item_transitions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "order_items_company_id_state_ship_by_index" ON "order_items" USING btree ("company_id","state","ship_by");--> statement-breakpoint
CREATE INDEX "order_items_company_id_order_id_index" ON "order_items" USING btree ("company_id","order_id");--> statement-breakpoint
CREATE INDEX "order_items_company_id_design_id_index" ON "order_items" USING btree ("company_id","design_id");--> statement-breakpoint
CREATE INDEX "order_items_company_id_blank_variant_id_index" ON "order_items" USING btree ("company_id","blank_variant_id");--> statement-breakpoint
CREATE INDEX "order_items_company_id_channel_sku_index" ON "order_items" USING btree ("company_id","channel_sku");--> statement-breakpoint
CREATE INDEX "order_items_company_id_transfer_id_index" ON "order_items" USING btree ("company_id","transfer_id");--> statement-breakpoint
CREATE INDEX "order_items_company_id_shipment_id_index" ON "order_items" USING btree ("company_id","shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_company_id_channel_channel_order_id_index" ON "orders" USING btree ("company_id","channel","channel_order_id");--> statement-breakpoint
CREATE INDEX "orders_company_id_status_ship_by_index" ON "orders" USING btree ("company_id","status","ship_by");--> statement-breakpoint
CREATE INDEX "orders_company_id_placed_at_index" ON "orders" USING btree ("company_id","placed_at");--> statement-breakpoint
CREATE INDEX "orders_company_id_order_no_index" ON "orders" USING btree ("company_id","order_no");--> statement-breakpoint
CREATE INDEX "orders_company_id_connection_id_index" ON "orders" USING btree ("company_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_artwork_company_id_order_item_id_index" ON "item_artwork" USING btree ("company_id","order_item_id");--> statement-breakpoint
CREATE INDEX "item_artwork_company_id_status_index" ON "item_artwork" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "personalization_templates_company_id_index" ON "personalization_templates" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bins_company_id_code_index" ON "bins" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "bins_company_id_order_id_index" ON "bins" USING btree ("company_id","order_id");--> statement-breakpoint
CREATE INDEX "gang_sheet_batches_company_id_status_created_at_index" ON "gang_sheet_batches" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gang_sheets_company_id_name_index" ON "gang_sheets" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "gang_sheets_company_id_status_created_at_index" ON "gang_sheets" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "gang_sheets_company_id_batch_id_index" ON "gang_sheets" USING btree ("company_id","batch_id");--> statement-breakpoint
CREATE INDEX "reprints_company_id_requested_at_index" ON "reprints" USING btree ("company_id","requested_at");--> statement-breakpoint
CREATE INDEX "reprints_company_id_order_item_id_index" ON "reprints" USING btree ("company_id","order_item_id");--> statement-breakpoint
CREATE INDEX "reprints_company_id_status_index" ON "reprints" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "scans_company_id_client_scan_id_index" ON "scans" USING btree ("company_id","client_scan_id");--> statement-breakpoint
CREATE INDEX "scans_company_id_scanned_at_index" ON "scans" USING btree ("company_id","scanned_at");--> statement-breakpoint
CREATE INDEX "scans_company_id_order_item_id_index" ON "scans" USING btree ("company_id","order_item_id");--> statement-breakpoint
CREATE INDEX "scans_company_id_station_created_at_index" ON "scans" USING btree ("company_id","station","created_at");--> statement-breakpoint
CREATE INDEX "transfers_company_id_gang_sheet_id_index" ON "transfers" USING btree ("company_id","gang_sheet_id");--> statement-breakpoint
CREATE INDEX "transfers_company_id_order_item_id_index" ON "transfers" USING btree ("company_id","order_item_id");--> statement-breakpoint
CREATE INDEX "labels_company_id_shipment_id_index" ON "labels" USING btree ("company_id","shipment_id");--> statement-breakpoint
CREATE INDEX "labels_company_id_tracking_code_index" ON "labels" USING btree ("company_id","tracking_code");--> statement-breakpoint
CREATE INDEX "package_presets_company_id_index" ON "package_presets" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "shipments_company_id_order_id_index" ON "shipments" USING btree ("company_id","order_id");--> statement-breakpoint
CREATE INDEX "shipments_company_id_status_index" ON "shipments" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_company_id_tracking_code_index" ON "shipments" USING btree ("company_id","tracking_code");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_settings_company_id_index" ON "shipping_settings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "accounts_user_id_index" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_company_id_dedupe_key_index" ON "alerts" USING btree ("company_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "alerts_company_id_status_created_at_index" ON "alerts" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_company_id_created_at_index" ON "audit_log" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_company_id_entity_type_entity_id_index" ON "audit_log" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_company_id_action_created_at_index" ON "audit_log" USING btree ("company_id","action","created_at");--> statement-breakpoint
CREATE INDEX "files_company_id_kind_index" ON "files" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "invitations_organization_id_index" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitations_email_index" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "jobs_company_id_kind_created_at_index" ON "jobs" USING btree ("company_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "locations_company_id_index" ON "locations" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_organization_id_user_id_index" ON "members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "members_user_id_index" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("created_at") WHERE dispatched_at is null;--> statement-breakpoint
CREATE INDEX "sessions_user_id_index" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_pins_company_id_user_id_index" ON "staff_pins" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_pins_company_id_pin_hash_index" ON "staff_pins" USING btree ("company_id","pin_hash");--> statement-breakpoint
CREATE INDEX "station_tokens_company_id_station_id_index" ON "station_tokens" USING btree ("company_id","station_id");--> statement-breakpoint
CREATE INDEX "stations_company_id_index" ON "stations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_index" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_access_company_id_vendor_company_id_gang_sheet_id_index" ON "vendor_access" USING btree ("company_id","vendor_company_id","gang_sheet_id");--> statement-breakpoint
CREATE INDEX "vendor_access_vendor_company_id_gang_sheet_id_index" ON "vendor_access" USING btree ("vendor_company_id","gang_sheet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_connections_company_id_vendor_company_id_index" ON "vendor_connections" USING btree ("company_id","vendor_company_id");--> statement-breakpoint
CREATE INDEX "vendor_connections_vendor_company_id_index" ON "vendor_connections" USING btree ("vendor_company_id");--> statement-breakpoint
CREATE POLICY "ai_credit_ledger_tenant" ON "ai_credit_ledger" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ai_jobs_tenant" ON "ai_jobs" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assistant_conversations_tenant" ON "assistant_conversations" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assistant_messages_tenant" ON "assistant_messages" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "listing_drafts_tenant" ON "listing_drafts" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "trademark_marks_public_read" ON "trademark_marks" AS PERMISSIVE FOR SELECT TO "invai_app" USING (true);--> statement-breakpoint
CREATE POLICY "plans_public_read" ON "plans" AS PERMISSIVE FOR SELECT TO "invai_app" USING (true);--> statement-breakpoint
CREATE POLICY "subscriptions_tenant" ON "subscriptions" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "usage_tenant" ON "usage" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "blank_variants_tenant" ON "blank_variants" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "design_files_tenant" ON "design_files" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "designs_tenant" ON "designs" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "products_tenant" ON "products" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "channel_connections_tenant" ON "channel_connections" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "import_runs_tenant" ON "import_runs" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "listing_variants_tenant" ON "listing_variants" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "listings_tenant" ON "listings" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sku_rules_tenant" ON "sku_rules" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ad_spend_tenant" ON "ad_spend" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "cost_settings_tenant" ON "cost_settings" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "profit_lines_tenant" ON "profit_lines" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_movements_tenant" ON "inventory_movements" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_settings_tenant" ON "inventory_settings" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "purchase_order_lines_tenant" ON "purchase_order_lines" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "purchase_orders_tenant" ON "purchase_orders" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stock_levels_tenant" ON "stock_levels" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "suppliers_tenant" ON "suppliers" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "buyer_pii_tenant" ON "buyer_pii" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_item_transitions_tenant" ON "order_item_transitions" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_items_tenant" ON "order_items" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "orders_tenant" ON "orders" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "item_artwork_tenant" ON "item_artwork" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "personalization_templates_tenant" ON "personalization_templates" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bins_tenant" ON "bins" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "gang_sheet_batches_tenant" ON "gang_sheet_batches" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "gang_sheets_tenant" ON "gang_sheets" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "gang_sheets_vendor_read" ON "gang_sheets" AS PERMISSIVE FOR SELECT TO "invai_app" USING (id in (select gang_sheet_id from vendor_access where vendor_company_id = nullif(current_setting('app.vendor_org_id', true), '')::uuid and revoked_at is null));--> statement-breakpoint
CREATE POLICY "gang_sheets_vendor_update" ON "gang_sheets" AS PERMISSIVE FOR UPDATE TO "invai_app" USING (id in (select gang_sheet_id from vendor_access where vendor_company_id = nullif(current_setting('app.vendor_org_id', true), '')::uuid and revoked_at is null)) WITH CHECK (id in (select gang_sheet_id from vendor_access where vendor_company_id = nullif(current_setting('app.vendor_org_id', true), '')::uuid and revoked_at is null));--> statement-breakpoint
CREATE POLICY "reprints_tenant" ON "reprints" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "scans_tenant" ON "scans" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "transfers_tenant" ON "transfers" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "transfers_vendor_read" ON "transfers" AS PERMISSIVE FOR SELECT TO "invai_app" USING (gang_sheet_id in (select gang_sheet_id from vendor_access where vendor_company_id = nullif(current_setting('app.vendor_org_id', true), '')::uuid and revoked_at is null));--> statement-breakpoint
CREATE POLICY "labels_tenant" ON "labels" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "package_presets_tenant" ON "package_presets" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "shipments_tenant" ON "shipments" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "shipping_settings_tenant" ON "shipping_settings" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "alerts_tenant" ON "alerts" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_log_tenant" ON "audit_log" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "files_tenant" ON "files" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "jobs_tenant" ON "jobs" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "locations_tenant" ON "locations" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "outbox_events_tenant" ON "outbox_events" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "staff_pins_tenant" ON "staff_pins" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "station_tokens_tenant" ON "station_tokens" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stations_tenant" ON "stations" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "vendor_access_tenant" ON "vendor_access" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "vendor_access_vendor_read" ON "vendor_access" AS PERMISSIVE FOR SELECT TO "invai_app" USING (vendor_company_id = nullif(current_setting('app.vendor_org_id', true), '')::uuid and revoked_at is null);--> statement-breakpoint
CREATE POLICY "vendor_connections_tenant" ON "vendor_connections" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "vendor_connections_vendor_read" ON "vendor_connections" AS PERMISSIVE FOR SELECT TO "invai_app" USING (vendor_company_id = nullif(current_setting('app.vendor_org_id', true), '')::uuid);