CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"channel" text NOT NULL,
	"delivery_id" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_channel_delivery_id_index" ON "webhook_deliveries" USING btree ("channel","delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received_at_index" ON "webhook_deliveries" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_company_id_received_at_index" ON "webhook_deliveries" USING btree ("company_id","received_at");--> statement-breakpoint
CREATE POLICY "webhook_deliveries_tenant" ON "webhook_deliveries" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);