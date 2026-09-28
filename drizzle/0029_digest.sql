CREATE TABLE "digest_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"digest_id" uuid NOT NULL,
	"insight_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"clicked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "digest_clicks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "digest_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"digest_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"lang" text DEFAULT 'en' NOT NULL,
	"message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "digest_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "digest_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"digest_id" uuid NOT NULL,
	"insight_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"vote" text NOT NULL,
	"reason" text,
	"voted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "digest_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "digest_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"digest_id" uuid NOT NULL,
	"detector" text NOT NULL,
	"section" text NOT NULL,
	"rank" integer NOT NULL,
	"score" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"impact_cents" integer,
	"fingerprint" text NOT NULL,
	"template_key" text NOT NULL,
	"action" jsonb NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommendation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_insights_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "digest_insights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "digest_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"day" text DEFAULT 'mon' NOT NULL,
	"hour" integer DEFAULT 7 NOT NULL,
	"ai_summary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "digest_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "digest_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"digest_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "digest_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"week_key" text NOT NULL,
	"week_start" date NOT NULL,
	"week_end" date NOT NULL,
	"period_from" timestamp with time zone NOT NULL,
	"period_to" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"narrative_status" text DEFAULT 'none' NOT NULL,
	"narrative" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"in_app_only" boolean DEFAULT false NOT NULL,
	"build_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digests_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "digests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "digest_clicks" ADD CONSTRAINT "digest_clicks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_clicks" ADD CONSTRAINT "digest_clicks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_clicks" ADD CONSTRAINT "digest_clicks_insight_fk" FOREIGN KEY ("company_id","insight_id") REFERENCES "public"."digest_insights"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_clicks" ADD CONSTRAINT "digest_clicks_digest_fk" FOREIGN KEY ("company_id","digest_id") REFERENCES "public"."digests"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_deliveries" ADD CONSTRAINT "digest_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_deliveries" ADD CONSTRAINT "digest_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_deliveries" ADD CONSTRAINT "digest_deliveries_digest_fk" FOREIGN KEY ("company_id","digest_id") REFERENCES "public"."digests"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_feedback" ADD CONSTRAINT "digest_feedback_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_feedback" ADD CONSTRAINT "digest_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_feedback" ADD CONSTRAINT "digest_feedback_insight_fk" FOREIGN KEY ("company_id","insight_id") REFERENCES "public"."digest_insights"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_feedback" ADD CONSTRAINT "digest_feedback_digest_fk" FOREIGN KEY ("company_id","digest_id") REFERENCES "public"."digests"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_insights" ADD CONSTRAINT "digest_insights_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_insights" ADD CONSTRAINT "digest_insights_digest_fk" FOREIGN KEY ("company_id","digest_id") REFERENCES "public"."digests"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_settings" ADD CONSTRAINT "digest_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_views" ADD CONSTRAINT "digest_views_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_views" ADD CONSTRAINT "digest_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_views" ADD CONSTRAINT "digest_views_digest_fk" FOREIGN KEY ("company_id","digest_id") REFERENCES "public"."digests"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "digest_clicks_company_id_insight_id_user_id_index" ON "digest_clicks" USING btree ("company_id","insight_id","user_id");--> statement-breakpoint
CREATE INDEX "digest_clicks_company_id_digest_id_index" ON "digest_clicks" USING btree ("company_id","digest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_deliveries_company_id_digest_id_user_id_channel_index" ON "digest_deliveries" USING btree ("company_id","digest_id","user_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_feedback_company_id_insight_id_user_id_index" ON "digest_feedback" USING btree ("company_id","insight_id","user_id");--> statement-breakpoint
CREATE INDEX "digest_feedback_company_id_digest_id_index" ON "digest_feedback" USING btree ("company_id","digest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_insights_company_id_digest_id_fingerprint_index" ON "digest_insights" USING btree ("company_id","digest_id","fingerprint");--> statement-breakpoint
CREATE INDEX "digest_insights_company_id_fingerprint_index" ON "digest_insights" USING btree ("company_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_settings_company_id_index" ON "digest_settings" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_views_company_id_digest_id_user_id_index" ON "digest_views" USING btree ("company_id","digest_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digests_company_id_week_key_index" ON "digests" USING btree ("company_id","week_key");--> statement-breakpoint
CREATE INDEX "digests_company_id_status_week_start_index" ON "digests" USING btree ("company_id","status","week_start");--> statement-breakpoint
CREATE POLICY "digest_clicks_tenant" ON "digest_clicks" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "digest_deliveries_tenant" ON "digest_deliveries" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "digest_feedback_tenant" ON "digest_feedback" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "digest_insights_tenant" ON "digest_insights" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "digest_settings_tenant" ON "digest_settings" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "digest_views_tenant" ON "digest_views" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "digests_tenant" ON "digests" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);