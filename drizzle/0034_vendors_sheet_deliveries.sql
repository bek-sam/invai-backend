CREATE TABLE "vendor_sheet_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"gang_sheet_id" uuid NOT NULL,
	"vendor_connection_id" uuid NOT NULL,
	"delivery" text NOT NULL,
	"seq" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"requested_by" uuid,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"message_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendor_sheet_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vendor_sheet_deliveries" ADD CONSTRAINT "vendor_sheet_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_sheet_deliveries" ADD CONSTRAINT "vendor_sheet_deliveries_gang_sheet_id_fk" FOREIGN KEY ("company_id","gang_sheet_id") REFERENCES "public"."gang_sheets"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_sheet_deliveries" ADD CONSTRAINT "vendor_sheet_deliveries_vendor_connection_id_fk" FOREIGN KEY ("company_id","vendor_connection_id") REFERENCES "public"."vendor_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_sheet_deliveries_company_id_gang_sheet_id_seq_index" ON "vendor_sheet_deliveries" USING btree ("company_id","gang_sheet_id","seq");--> statement-breakpoint
CREATE POLICY "vendor_sheet_deliveries_tenant" ON "vendor_sheet_deliveries" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);