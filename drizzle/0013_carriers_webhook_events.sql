CREATE TABLE "carrier_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"detail" text,
	"subject_id" text,
	"occurred_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "carrier_webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "carrier_webhook_events" ADD CONSTRAINT "carrier_webhook_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_webhook_events_provider_event_id_index" ON "carrier_webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "carrier_webhook_events_received_at_index" ON "carrier_webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "carrier_webhook_events_company_id_received_at_index" ON "carrier_webhook_events" USING btree ("company_id","received_at");--> statement-breakpoint
CREATE INDEX "carrier_webhook_events_provider_subject_id_occurred_at_index" ON "carrier_webhook_events" USING btree ("provider","subject_id","occurred_at");--> statement-breakpoint
CREATE POLICY "carrier_webhook_events_tenant" ON "carrier_webhook_events" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Carrier webhook events are recorded by the system role only (decision 0009's shape). The app
-- role may read its own company's rows (tenant policy) but never write, so no request can
-- pre-claim an EasyPost event id and suppress a real tracking update.
REVOKE INSERT, UPDATE, DELETE ON carrier_webhook_events FROM invai_app;
