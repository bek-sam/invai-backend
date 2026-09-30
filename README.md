# invai-backend

The API server and the background workers. They share one codebase and run as two processes:

| Process | Entry | Does |
| --- | --- | --- |
| API | `src/api/server.ts` | Hono server: oRPC procedures (from `@invai/contracts`), Better Auth, channel webhooks, Server-Sent Events for live updates |
| Worker | `src/worker/index.ts` | BullMQ workers: order sync, sheet building, labels, tracking push, AI jobs, reports; plus the outbox relay |

## Layout

```
src/
  env.ts          Validated env vars (Zod); env.mocks.{ai,carrier,shopify,supplier,billing,mail}; production key guard
  auth.ts         Better Auth config (organizations plugin, disabledPaths, rate limits)
  api/            Hono app, oRPC handler, webhooks, SSE
  worker/         BullMQ workers and the outbox relay
  modules/        Business logic by domain. Modules call each other's exported functions, never each other's tables
  integrations/   Adapters: channels (Etsy, Amazon, Shopify, TikTok, Walmart, CSV), carriers (EasyPost), suppliers (S&S, SanMar), DTF vendors
  ai/             AI gateway: every Claude call goes through here (metering, validation, logging)
  db/             Drizzle schema, RLS policies, withTenant()/withSystem() helpers, migrations, seed/
  lib/            queues, outbox, realtime, s3, crypto, audit, csv, ratelimit, errors, log
```

## Rules

- **Every tenant query runs inside `withTenant(companyId, fn)`.** It sets `app.company_id` for the transaction so Postgres row-level security applies. The app connects as `invai_app`, which is not the table owner and has no BYPASSRLS.
- **State changes write an outbox event in the same transaction.** Workers never trust in-memory events.
- **Jobs are idempotent.** Set `jobId` to a stable key such as `push-tracking:{shipmentId}`.
- **Buyer personal data never goes to the AI gateway.**

## Local development

Start Postgres, Valkey and MinIO from `invai-infra/local`, then:

```
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm db:seed      # once, on a fresh database: seeds the "Desert Bloom Tees" demo shop
pnpm dev:api      # http://localhost:3000
pnpm dev:worker
```

`pnpm db:reset` drops the schema **and** obliterates the app's five BullMQ queues in the Redis DB
of `REDIS_URL` (only `bull:<queue>:*`; rate-limit and realtime keys and other Redis DBs stay), so a
worker started afterwards never replays jobs for rows that no longer exist. Restart a running
worker after a reset so its repeatable sweeps re-register. The seed is safe with the worker
running: each builder phase parks the outbox events it emitted and the last step releases them all
(`src/db/seed/outbox-hold.ts`). Seeding a DB copy? Set `SEED_OUTPUT_FILE=<path>` so the copy's run
doesn't overwrite the shared `seed-output.json`. `pnpm test` redirects `REDIS_URL` the same way it
redirects the database URLs (B-205): any `REDIS_URL` whose path isn't written as a plain positive
integer (`/14`) — no path, `/0`, `/0/`, `/0.5`, `/0x1`, blank, anything else — is treated as DB 0
and moves to DB 15, so a dev or CI worker on DB 0 never sees test jobs or streams. Set
`TEST_REDIS_URL` to pick a different test DB, or pin `REDIS_URL=redis://localhost:6379/<n>`
yourself (a DB written that way is kept as-is, never redirected) — the pattern to use when several
agents run the suite at once. `TEST_REDIS_URL` itself must be a pinned non-zero DB the same way;
one written as DB 0 fails the boot with a clear error rather than silently running on DB 0. `pnpm
test` also truncates every tenant table in `invai_test` once, at the very start of the run (B-205
AC6), so a shared `invai_test` that other runs (or other agents) have left full of rows never
changes what a test sees: an unscoped, cross-tenant read like `findStuckIntents()`'s `LIMIT 200`
sweep only ever sees this run's own rows. The truncate refuses to run against anything whose
database name doesn't contain "test" and isn't exactly `TEST_DATABASE_URL`/`TEST_MIGRATION_DATABASE_URL`
(`src/test/db-safety.ts`), so it can never reach the dev database even if `TEST_DATABASE_URL` is
unset or misconfigured. A single test file that needs a mid-run clean slate (several tests in the
same file colliding) still calls `truncateAll()` itself (`src/test/fixtures.ts`). This raises the
cost of two agents sharing plain `invai_test` at once beyond the existing row-count and
unique-constraint collisions: a run that starts partway through another now wipes its
in-progress rows too. Pin your own `TEST_DATABASE_URL`/`TEST_MIGRATION_DATABASE_URL` (per
`team/agent-brief.md`) whenever `invai_test` might already be busy.

No real API keys are needed: every integration (Claude, EasyPost, Shopify, S&S) falls back to a
mock provider automatically when its env var is unset (`env.mocks.*` in `src/env.ts`). See
`invai-docs/build/runbook.md` for the env var reference and the mock-to-real switches, and
`invai-docs/architecture.md` for the full design. Outgoing mail goes to Mailpit
(`SMTP_URL`/`MAIL_FROM` default to it outside production; UI on http://localhost:8025).

## AI evals

`pnpm evals` (or `pnpm evals listing_copy trademark_judge` for a subset) runs the eval sets in
`evals/<route>/cases.jsonl` through the real gateway (`src/ai/gateway.ts`) against a throwaway
tenant, and prints pass rate, cost and latency per route (`evals/run.ts`; case format and required
coverage in `.claude/skills/ai-feature-with-evals/eval-template.md`). With no `ANTHROPIC_API_KEY`
(CI, or a local run without one) every call goes to the mock provider automatically, so the run
checks the plumbing (schema-valid output, correct cardinality, the gateway/validator wiring) rather
than model quality — a fixed mock can't demonstrate that either way. With a key it calls the real
model and scores each case against its `expect`. `evals/baseline.json` is a checked-in mock-mode
run to diff future runs against. See decision `0007-ai-model-policy.md`: no prompt or model change
ships without an eval diff.

## Production build and required keys

```
pnpm build        # tsup (tsup.config.ts): dist/server.js (api) and dist/index.js (worker)
pnpm start:api    # node dist/server.js
pnpm start:worker # node dist/index.js
```

`@invai/contracts` is bundled; every other dependency loads from `node_modules`.

With `NODE_ENV=production` the api and worker refuse to start, with one message listing every
missing key, unless all of these are set: `EASYPOST_API_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SMTP_URL`,
`MAIL_FROM` (`PRODUCTION_KEYS` in `src/env.ts`). Without them a provider would silently run on its
mock and fake success. A demo or staging stage can set `ALLOW_MOCKS=true` to boot anyway; it logs
a warning on every start, and mail without `SMTP_URL` is logged, not sent. Development and tests
need none of these keys.

The public `/health` reports only dependency status (db, redis, imaging, s3). Which providers run
on mocks is logged at startup, never exposed over HTTP.
