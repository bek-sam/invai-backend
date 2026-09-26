-- Role-level Postgres timeouts (T-12-2, B-16, research §1/§2.2 "MUST"). Set on the role, not per
-- query or per pooler, so they survive PgBouncer/RDS Proxy/whatever sits in front later.
-- ALTER ROLE ... SET only changes the *default* for connections made after this runs; it does
-- not affect the session currently running this migration.

-- invai_app: every request-scoped and job-scoped query. A runaway query is cancelled by Postgres
-- itself well before a client timeout or a stuck deploy would notice.
ALTER ROLE invai_app SET statement_timeout = '15s';--> statement-breakpoint
ALTER ROLE invai_app SET idle_in_transaction_session_timeout = '30s';--> statement-breakpoint
ALTER ROLE invai_app SET lock_timeout = '5s';--> statement-breakpoint

-- invai (the owner role): migrations, the outbox relay, cross-tenant sweeps and the reports/purge
-- jobs that run through systemPool/withSystem. There is no separate "invai_system" login role in
-- this setup (see src/db/client.ts, invai-infra/local/init.sql) -- invai IS the system/reports
-- role the card asks for a longer timeout on. Long-running reports (exports, purges) that
-- legitimately need more than 5 minutes set SET LOCAL statement_timeout inside their own
-- transaction instead of relying on this default.
ALTER ROLE invai SET statement_timeout = '5min';
