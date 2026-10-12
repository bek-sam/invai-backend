ALTER TABLE "shipments" ADD COLUMN "tracker_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracker_check_failed_at" timestamp with time zone;