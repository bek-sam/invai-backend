CREATE TABLE "photo_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"job_id" uuid NOT NULL,
	"analysis" jsonb,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photo_analyses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "photo_compositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"source" text DEFAULT 'template' NOT NULL,
	"garment" text NOT NULL,
	"view" text NOT NULL,
	"color_name" text NOT NULL,
	"color_hex" text NOT NULL,
	"placement" text NOT NULL,
	"scene_kind" text,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"charged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_compositions_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "photo_compositions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "photo_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"composition_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"preset" text NOT NULL,
	"slot" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"key" text,
	"width_px" integer,
	"height_px" integer,
	"format" text,
	"checks" jsonb,
	"design_lock_score" double precision,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"contains_synthetic_person" boolean DEFAULT false NOT NULL,
	"drawn_template" boolean DEFAULT true NOT NULL,
	"alt_text" text,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"model" text,
	"error" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photo_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "photo_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"design_name" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"spec_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"garments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"colors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"views" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"underbase_preview" boolean DEFAULT true NOT NULL,
	"credits_estimated" integer DEFAULT 0 NOT NULL,
	"error" text,
	"completed_at" timestamp with time zone,
	"zip_status" text DEFAULT 'none' NOT NULL,
	"zip_channel" text,
	"zip_job_id" uuid,
	"zip_fingerprint" text,
	"zip_key" text,
	"zip_bytes" integer,
	"zip_image_count" integer DEFAULT 0 NOT NULL,
	"zip_built_at" timestamp with time zone,
	"zip_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_sets_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "photo_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "photo_analyses" ADD CONSTRAINT "photo_analyses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_analyses" ADD CONSTRAINT "photo_analyses_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_analyses" ADD CONSTRAINT "photo_analyses_design_fk" FOREIGN KEY ("company_id","design_id") REFERENCES "public"."designs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_compositions" ADD CONSTRAINT "photo_compositions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_compositions" ADD CONSTRAINT "photo_compositions_set_fk" FOREIGN KEY ("company_id","set_id") REFERENCES "public"."photo_sets"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_images" ADD CONSTRAINT "photo_images_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_images" ADD CONSTRAINT "photo_images_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_images" ADD CONSTRAINT "photo_images_set_fk" FOREIGN KEY ("company_id","set_id") REFERENCES "public"."photo_sets"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_images" ADD CONSTRAINT "photo_images_composition_fk" FOREIGN KEY ("company_id","composition_id") REFERENCES "public"."photo_compositions"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_sets" ADD CONSTRAINT "photo_sets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_sets" ADD CONSTRAINT "photo_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_sets" ADD CONSTRAINT "photo_sets_design_fk" FOREIGN KEY ("company_id","design_id") REFERENCES "public"."designs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "photo_analyses_company_id_design_id_index" ON "photo_analyses" USING btree ("company_id","design_id");--> statement-breakpoint
CREATE UNIQUE INDEX "photo_compositions_company_id_set_id_garment_view_color_hex_index" ON "photo_compositions" USING btree ("company_id","set_id","garment","view","color_hex");--> statement-breakpoint
CREATE UNIQUE INDEX "photo_images_company_id_composition_id_preset_index" ON "photo_images" USING btree ("company_id","composition_id","preset");--> statement-breakpoint
CREATE INDEX "photo_images_company_id_set_id_channel_slot_index" ON "photo_images" USING btree ("company_id","set_id","channel","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "photo_sets_company_id_idempotency_key_index" ON "photo_sets" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "photo_sets_company_id_created_at_id_index" ON "photo_sets" USING btree ("company_id","created_at","id");--> statement-breakpoint
CREATE INDEX "photo_sets_company_id_design_id_created_at_index" ON "photo_sets" USING btree ("company_id","design_id","created_at");--> statement-breakpoint
CREATE POLICY "photo_analyses_tenant" ON "photo_analyses" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "photo_compositions_tenant" ON "photo_compositions" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "photo_images_tenant" ON "photo_images" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "photo_sets_tenant" ON "photo_sets" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);