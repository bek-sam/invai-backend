CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid,
	"channel" text NOT NULL,
	"topic" text NOT NULL,
	"delivery_id" text NOT NULL,
	"external_shop_id" text NOT NULL,
	"channel_customer_id" text,
	"channel_request_id" text,
	"channel_order_ids" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "privacy_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_requests_company_id_channel_delivery_id_index" ON "privacy_requests" USING btree ("company_id","channel","delivery_id");--> statement-breakpoint
CREATE INDEX "privacy_requests_company_id_status_due_at_index" ON "privacy_requests" USING btree ("company_id","status","due_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_status_due_at_index" ON "privacy_requests" USING btree ("status","due_at");--> statement-breakpoint
CREATE POLICY "privacy_requests_tenant" ON "privacy_requests" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Privacy requests are recorded by the system role only (decision 0009's shape): the compliance
-- webhook handler writes them. The app role may read its own company's rows but never write, so
-- no request can forge or close a privacy request.
REVOKE INSERT, UPDATE, DELETE ON privacy_requests FROM invai_app;
