CREATE TABLE "refund_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid,
	"channel" text NOT NULL,
	"source" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"fee_recovered_cents" integer DEFAULT 0 NOT NULL,
	"channel_refund_id" text,
	"refunded_at" timestamp with time zone NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refund_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "exported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_events_company_id_channel_channel_refund_id_index" ON "refund_events" USING btree ("company_id","channel","channel_refund_id");--> statement-breakpoint
CREATE INDEX "refund_events_company_id_order_id_index" ON "refund_events" USING btree ("company_id","order_id");--> statement-breakpoint
CREATE INDEX "refund_events_company_id_refunded_at_index" ON "refund_events" USING btree ("company_id","refunded_at");--> statement-breakpoint
CREATE POLICY "refund_events_tenant" ON "refund_events" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);