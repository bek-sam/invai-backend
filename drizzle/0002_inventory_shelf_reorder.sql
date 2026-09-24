ALTER TABLE "stock_levels" ADD COLUMN "reorder_point" integer;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD COLUMN "reorder_qty" integer;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD COLUMN "shelf" text;