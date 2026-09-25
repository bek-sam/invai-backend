ALTER TABLE "users" ADD COLUMN "pin_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Hand-added: keep only the newest pending invite per company and email, so the unique index can build.
UPDATE "invitations" SET "status" = 'canceled' WHERE "status" = 'pending' AND "id" IN (SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "organization_id", "email" ORDER BY "created_at" DESC, "id" DESC) AS "rn" FROM "invitations" WHERE "status" = 'pending') AS "ranked" WHERE "ranked"."rn" > 1);--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_org_email_unique" ON "invitations" USING btree ("organization_id","email") WHERE "invitations"."status" = 'pending';
