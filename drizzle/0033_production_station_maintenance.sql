CREATE TABLE "station_maintenance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"end_note" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_by" uuid,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "station_maintenance_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD COLUMN "bin_code" text;--> statement-breakpoint
ALTER TABLE "station_maintenance_events" ADD CONSTRAINT "station_maintenance_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_maintenance_events" ADD CONSTRAINT "station_maintenance_events_station_id_fk" FOREIGN KEY ("company_id","station_id") REFERENCES "public"."stations"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "station_maintenance_events_open_unique" ON "station_maintenance_events" USING btree ("company_id","station_id") WHERE "station_maintenance_events"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "station_maintenance_events_company_id_station_id_started_at_index" ON "station_maintenance_events" USING btree ("company_id","station_id","started_at");--> statement-breakpoint
CREATE INDEX "station_maintenance_events_company_id_started_at_index" ON "station_maintenance_events" USING btree ("company_id","started_at");--> statement-breakpoint
CREATE POLICY "station_maintenance_events_tenant" ON "station_maintenance_events" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);