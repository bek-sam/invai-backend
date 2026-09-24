-- Webhook deliveries are recorded before a delivery is routed to a shop, by the system role only.
-- The app role may read its own company's rows (tenant policy) but never write, so no request
-- can pre-claim a delivery id and suppress another shop's webhook.
REVOKE INSERT, UPDATE, DELETE ON webhook_deliveries FROM invai_app;
