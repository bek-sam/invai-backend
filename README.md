# invai-backend

The API server and the background workers. They share one codebase and run as two processes:

| Process | Entry | Does |
| --- | --- | --- |
| API | `src/api/server.ts` | Hono server: oRPC procedures (from `@invai/contracts`), Better Auth, channel webhooks, Server-Sent Events for live updates |
| Worker | `src/worker/index.ts` | BullMQ workers: order sync, sheet building, labels, tracking push, AI jobs, reports; plus the outbox relay |

## Layout

```
src/
  api/            Hono app, oRPC handler, webhooks, SSE
  worker/         BullMQ workers and the outbox relay
  modules/        Business logic by domain. Modules call each other's exported functions, never each other's tables
  integrations/   Adapters: channels (Etsy, Amazon, Shopify, TikTok, Walmart, CSV), carriers (EasyPost), suppliers (S&S, SanMar), DTF vendors
  ai/             AI gateway: every Claude call goes through here (metering, validation, logging)
  db/             Drizzle schema, RLS policies, withTenant() helper
  lib/            env, queues, outbox, realtime
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
pnpm dev:api      # http://localhost:3000
pnpm dev:worker
```

See `invai-docs/architecture.md` for the full design.
