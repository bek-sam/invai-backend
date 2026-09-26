ALTER TABLE "listing_drafts" ALTER COLUMN "content" SET DEFAULT '{"title":"","description":"","tags":[],"bullets":[],"attributes":{},"price":null,"disclosures":[],"productionPartner":null}'::jsonb;--> statement-breakpoint
ALTER TABLE "listing_drafts" ADD COLUMN "trademark_reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "listing_drafts" ADD COLUMN "trademark_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listing_drafts" ADD COLUMN "trademark_review_note" text;--> statement-breakpoint
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_trademark_reviewed_by_users_id_fk" FOREIGN KEY ("trademark_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;