-- Stripe webhook events are recorded by the system role only, in the transaction that applies
-- them (decision 0009's shape). The app role may read its own company's rows (tenant policy) but
-- never write, so no request can pre-claim a Stripe event id and suppress a real payment event.
REVOKE INSERT, UPDATE, DELETE ON billing_webhook_events FROM invai_app;
