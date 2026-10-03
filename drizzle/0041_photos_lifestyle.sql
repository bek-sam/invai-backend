CREATE TABLE "photo_pushes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"product_gid" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"image_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pushed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"requested_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photo_pushes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "photo_compositions_company_id_set_id_garment_view_color_hex_index";--> statement-breakpoint
ALTER TABLE "photo_compositions" ADD COLUMN "scene_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "photo_compositions" ADD COLUMN "scene_base_key" text;--> statement-breakpoint
ALTER TABLE "photo_compositions" ADD COLUMN "scene_mask_key" text;--> statement-breakpoint
ALTER TABLE "photo_compositions" ADD COLUMN "scene_print_box_px" jsonb;--> statement-breakpoint
ALTER TABLE "photo_compositions" ADD COLUMN "scene_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "photo_compositions" ADD COLUMN "scene_key" text;--> statement-breakpoint
ALTER TABLE "photo_compositions" ADD COLUMN "contains_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "photo_compositions" ADD COLUMN "scene_model" text;--> statement-breakpoint
ALTER TABLE "photo_compositions" ADD COLUMN "scene_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "photo_sets" ADD COLUMN "lifestyle" jsonb;--> statement-breakpoint
ALTER TABLE "photo_pushes" ADD CONSTRAINT "photo_pushes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_pushes" ADD CONSTRAINT "photo_pushes_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_pushes" ADD CONSTRAINT "photo_pushes_set_fk" FOREIGN KEY ("company_id","set_id") REFERENCES "public"."photo_sets"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "photo_pushes_company_id_idempotency_key_index" ON "photo_pushes" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "photo_pushes_company_id_set_id_created_at_index" ON "photo_pushes" USING btree ("company_id","set_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "photo_compositions_company_id_set_id_garment_view_color_hex_scene_index_index" ON "photo_compositions" USING btree ("company_id","set_id","garment","view","color_hex","scene_index");--> statement-breakpoint
CREATE POLICY "photo_pushes_tenant" ON "photo_pushes" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);