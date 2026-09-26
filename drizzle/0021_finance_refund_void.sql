ALTER TABLE "refund_events" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refund_events" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "refund_events" ADD COLUMN "voided_by" uuid;