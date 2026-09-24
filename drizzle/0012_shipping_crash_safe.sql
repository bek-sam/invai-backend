ALTER TABLE "shipments" ADD COLUMN "buy_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "void_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "push_attempted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_one_purchased_per_shipment" ON "labels" USING btree ("company_id","shipment_id") WHERE status = 'purchased';