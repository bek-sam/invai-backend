CREATE TABLE "market_design_niches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"niches" text[] DEFAULT '{}' NOT NULL,
	"source" text DEFAULT 'unclassified' NOT NULL,
	"confidence" double precision,
	"corrected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_design_niches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "market_price_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"source" text NOT NULL,
	"granularity" text NOT NULL,
	"period" text NOT NULL,
	"observations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"personalized" boolean DEFAULT false NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	"q1_cents" integer,
	"median_cents" integer,
	"q3_cents" integer,
	"featured_cents" integer,
	"offer_count" integer,
	"licence" text NOT NULL,
	"mock" boolean NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_price_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "market_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"action" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_on" text NOT NULL,
	"design_id" uuid,
	"niche" text,
	"channel" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" double precision NOT NULL,
	"band" text NOT NULL,
	"mock" boolean NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_signal_ids" uuid[] DEFAULT '{}' NOT NULL,
	"signals_snapshot" jsonb,
	"baseline" jsonb,
	"stale_after_days" double precision NOT NULL,
	"shown_in" text,
	"shown_at" timestamp with time zone,
	"shown_ref" text,
	"vote" text,
	"voted_at" timestamp with time zone,
	"voted_by" uuid,
	"adopted_at" timestamp with time zone,
	"outcome" text,
	"outcome_at" timestamp with time zone,
	"outcome_detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "market_series_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"query" text NOT NULL,
	"granularity" text NOT NULL,
	"period" text NOT NULL,
	"value" double precision NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"licence" text NOT NULL,
	"mock" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_series_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "market_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"signal" text NOT NULL,
	"source" text NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	"sample_factor" double precision DEFAULT 0 NOT NULL,
	"reliability" double precision DEFAULT 0 NOT NULL,
	"agreement" double precision DEFAULT 1 NOT NULL,
	"licence" text NOT NULL,
	"mock" boolean NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"computed_on" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "market_design_niches" ADD CONSTRAINT "market_design_niches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_design_niches" ADD CONSTRAINT "market_design_niches_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_price_snapshots" ADD CONSTRAINT "market_price_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_price_snapshots" ADD CONSTRAINT "market_price_snapshots_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_recommendations" ADD CONSTRAINT "market_recommendations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_recommendations" ADD CONSTRAINT "market_recommendations_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_signals" ADD CONSTRAINT "market_signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_design_niches_company_id_design_id_index" ON "market_design_niches" USING btree ("company_id","design_id");--> statement-breakpoint
CREATE UNIQUE INDEX "market_price_snapshots_company_id_design_id_channel_source_granularity_period_index" ON "market_price_snapshots" USING btree ("company_id","design_id","channel","source","granularity","period");--> statement-breakpoint
CREATE INDEX "market_price_snapshots_company_id_granularity_period_index" ON "market_price_snapshots" USING btree ("company_id","granularity","period");--> statement-breakpoint
CREATE UNIQUE INDEX "market_recommendations_company_id_dedupe_key_created_on_index" ON "market_recommendations" USING btree ("company_id","dedupe_key","created_on");--> statement-breakpoint
CREATE INDEX "market_recommendations_company_id_created_at_index" ON "market_recommendations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "market_recommendations_company_id_design_id_index" ON "market_recommendations" USING btree ("company_id","design_id");--> statement-breakpoint
CREATE UNIQUE INDEX "market_series_cache_source_query_granularity_period_index" ON "market_series_cache" USING btree ("source","query","granularity","period");--> statement-breakpoint
CREATE UNIQUE INDEX "market_signals_company_id_subject_type_subject_id_signal_source_index" ON "market_signals" USING btree ("company_id","subject_type","subject_id","signal","source");--> statement-breakpoint
CREATE INDEX "market_signals_company_id_computed_on_index" ON "market_signals" USING btree ("company_id","computed_on");--> statement-breakpoint
CREATE POLICY "market_design_niches_tenant" ON "market_design_niches" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "market_price_snapshots_tenant" ON "market_price_snapshots" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "market_recommendations_tenant" ON "market_recommendations" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "market_series_cache_public_read" ON "market_series_cache" AS PERMISSIVE FOR SELECT TO "invai_app" USING (true);--> statement-breakpoint
CREATE POLICY "market_signals_tenant" ON "market_signals" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- ADR 0015: the global demand cache is written only by the nightly job (owner connection).
-- The app role may read it (public-read policy) but never write it.
REVOKE INSERT, UPDATE, DELETE ON market_series_cache FROM invai_app;
