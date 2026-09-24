-- A store can be connected to one company only. Should two companies already both be connected
-- to the same store, the earliest connection keeps it and the others are disconnected.
UPDATE "channel_connections" c SET "status" = 'disconnected', "last_error" = 'Store is connected to another account', "last_error_at" = now()
WHERE c."status" = 'connected' AND c."external_shop_id" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "channel_connections" o
  WHERE o."channel" = c."channel" AND o."external_shop_id" = c."external_shop_id" AND o."status" = 'connected'
    AND (coalesce(o."connected_at", o."created_at"), o."id") < (coalesce(c."connected_at", c."created_at"), c."id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_connected_shop_uq" ON "channel_connections" USING btree ("channel","external_shop_id") WHERE status = 'connected' and external_shop_id is not null;