CREATE TABLE "floor_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"order_id" uuid,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "floor_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "floor_requests" ADD CONSTRAINT "floor_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floor_requests" ADD CONSTRAINT "floor_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "floor_requests_company_id_kind_idempotency_key_index" ON "floor_requests" USING btree ("company_id","kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "floor_requests_company_id_order_id_index" ON "floor_requests" USING btree ("company_id","order_id");--> statement-breakpoint
CREATE POLICY "floor_requests_tenant" ON "floor_requests" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);