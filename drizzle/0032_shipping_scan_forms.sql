CREATE TABLE "address_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"address_hash" text NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "address_verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scan_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"carrier" text NOT NULL,
	"date" text NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"shipment_ids" uuid[] DEFAULT '{}' NOT NULL,
	"label_count" integer DEFAULT 0 NOT NULL,
	"carrier_form_id" text,
	"file_key" text,
	"attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scan_forms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "address_verifications" ADD CONSTRAINT "address_verifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_verifications" ADD CONSTRAINT "address_verifications_order_id_fk" FOREIGN KEY ("company_id","order_id") REFERENCES "public"."orders"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_forms" ADD CONSTRAINT "scan_forms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "address_verifications_company_id_order_id_index" ON "address_verifications" USING btree ("company_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_forms_company_id_carrier_date_index" ON "scan_forms" USING btree ("company_id","carrier","date");--> statement-breakpoint
CREATE INDEX "scan_forms_company_id_created_at_index" ON "scan_forms" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE POLICY "address_verifications_tenant" ON "address_verifications" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "scan_forms_tenant" ON "scan_forms" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);