CREATE TABLE "billing_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"stripe_event_id" text NOT NULL,
	"type" text NOT NULL,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "billing_webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "stripe_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_webhook_events" ADD CONSTRAINT "billing_webhook_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_stripe_event_id_index" ON "billing_webhook_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_received_at_index" ON "billing_webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_company_id_received_at_index" ON "billing_webhook_events" USING btree ("company_id","received_at");--> statement-breakpoint
CREATE POLICY "billing_webhook_events_tenant" ON "billing_webhook_events" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);