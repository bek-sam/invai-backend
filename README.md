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
doesn't overwrite the shared `seed-output.json`.

**`pnpm test` gets its own database and Redis DB automatically (T-P1-1, B-228).** Unless you pin
`TEST_DATABASE_URL`/`TEST_MIGRATION_DATABASE_URL`, `global-setup.ts` (via `src/test/test-db.ts`)
creates a fresh `invai_test_<pid>` cloned from a migrated template `invai_test_tpl`, and drops it
when the run ends. Unless you pin `REDIS_URL` to a non-zero DB or set `TEST_REDIS_URL`,
`src/test/test-redis.ts` claims a free Redis DB from 1–14 (a `SET NX` lock key held in DB 15,
released at teardown) and fails with a clear message if every one is already claimed; DB 0 (the
dev/CI worker's DB) and DB 15 are never handed out as a test target. **This means two or more
agents can run `pnpm test` at the same time with no coordination** — the old rule of pinning your
own `TEST_DATABASE_URL`/`REDIS_URL` by hand (`team/agent-brief.md`) is retired for a plain `pnpm
test`; pin them yourself only when you want a *specific* database (for example to inspect it
afterwards, or to point every worker at the same scratch DB another tool already seeded).
A per-run database that survives a crashed run (`invai_test_<pid>` whose pid is dead on this host)
is swept at the next setup once it's over an hour old; the template and anything not matching that
exact `invai_test_<digits>` pattern — including a plain `invai_test`, or a hand-pinned name like
`invai_t23_0_test` — is never touched. `assertTestDatabase` (`src/test/db-safety.ts`) still guards
every database `global-setup.ts` touches: it refuses a name that isn't a whole `test` segment
(`invai_test`, not `invai_latest`), it decodes the database name before comparing (so a
percent-encoded `%69nvai` is still refused as the dev DB, B-215), and it refuses the dev
database — literally named `invai`, or whatever `DATABASE_URL`/`MIGRATION_DATABASE_URL` raw point
at — even if pinned via `TEST_DATABASE_URL`/`TEST_MIGRATION_DATABASE_URL` by mistake. The claimed
(or pinned) URLs reach every worker through Vitest's `provide()`/`inject()` channel
(`src/test/setup-env.ts`, `src/test/provided-context.ts`), not by relying on `process.env`
propagating into a worker thread or fork for free.

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
