# Modules: how to build one

Each folder under `src/modules/` is one domain module (v1-plan 5.2). The `catalog` module is
the reference implementation; copy its shape. `tenancy` and `files` are also complete.

```
modules/<name>/
  service.ts     public functions: (tx, ctx, input) => output. The only way other modules touch this data.
  router.ts      oRPC handlers: unwrap the tenant, open withTenant(), call the service. One line each.
  jobs.ts        defineJob() declarations + onEvent() subscriptions. Imported by modules/jobs.ts.
  *.test.ts      Vitest against the real invai_test database (RLS on).
```

## Rules

1. **A module never queries another module's tables.** Call that module's `service.ts`. (Reading a
   foreign table for a count in a list view is tolerated; writing never is.)
2. **Every order-item state change goes through `modules/orders/state-machine.ts`:**
   `transitionItem(tx, itemId, to, { actor, stationKind?, reason?, data? })`. It validates against
   contracts `ITEM_TRANSITIONS`, writes `order_item_transitions` + `audit_log` + outbox events,
   recomputes the order status and publishes realtime after commit. Never `update(orderItems).set({state})`.
3. **`withTenant(companyId, fn)` for every request-scoped query.** The router does it; services take
   the `tx`. `withVendor()` for vendor-portal reads. `withSystem()` (owner role, no RLS) only in the
   outbox relay, cross-tenant jobs and the seed.
4. **Same-transaction side effects:** `audit(tx, {...})` for anything a person did,
   `emit(tx, companyId, "event.name", payload)` for anything a worker or another module reacts to.
   Realtime pushes go through `afterCommit(tx, () => publish(companyId, {...}))`.
5. **Insert `companyId` explicitly** on every tenant row (RLS `WITH CHECK` rejects the wrong one).
   **A reference from one tenant table to another is a composite FK** (T-22-2, S-26): the parent
   has `tenantKey("<table>", t)` (a `(company_id, id)` unique key, `src/db/schema/_shared.ts`) and
   the child declares
   `foreignKey({ name: "<child>_<col>_fk", columns: [t.companyId, t.<col>], foreignColumns: [parent.companyId, parent.id] }).onDelete(...)`
   instead of `.references(() => parent.id)`. FK checks ignore RLS, so a single-column FK would let
   a row of shop B point at shop A's row from a job or the seed; `src/db/fk-coverage.test.ts`
   fails on any single-column tenant-to-tenant FK. A nullable reference with `set null` needs
   `ON DELETE SET NULL (<col>)` in the migration SQL (drizzle emits a plain `SET NULL`, which
   would null `company_id`): edit the generated file before it is applied, as 0030 does.
   References to `users` and `companies` stay single-column.
   **Trigram indexes don't help `ilike '%q%'` under RLS:** `textlike`/`texticlike`/`similarity`
   are not leakproof, and an RLS policy is a security barrier, so the planner never uses a
   `gin_trgm_ops` index condition for `invai_app` (only `=`/`starts_with` are leakproof). Don't
   add one expecting a plan change; search cost is a seq scan within the tenant's rows.
6. **Errors:** throw the helpers in `src/lib/errors.ts` (`notFound`, `conflict`, `invalidTransition`,
   `upstream`, `planLimit`...). They map to the contract's `COMMON_ERRORS`.
7. Money in cents, inches for sizes, ISO strings out (`row.createdAt.toISOString()`), UUIDs everywhere.

## Router pattern

```ts
import { contract } from "@invai/contracts";
import { authed, pub, stubRouter } from "../../api/orpc";
import { withTenant } from "../../db/client";
import * as svc from "./service";

export const ordersRouter = authed.orders.router({
  ...stubRouter(authed.orders, contract.orders, ["orders"]),   // 501 for what you haven't built yet
  list: authed.orders.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listOrders(tx, tenant, input)),
  ),
});
```

- `authed` guarantees `context.tenant: TenantContext` = `{ companyId, orgType, userId, role,
  permissions, sessionKind, station, user, actor }`. The auth mode and permission from the
  procedure's contract `.meta` are enforced before your handler runs.
- `pub` is the guarded builder without a tenant (only for `auth: "public"` / `"station"` procedures).
- Procedures that move money also need a verified email: add the path to
  `EMAIL_VERIFIED_PROCEDURES` in `src/api/orpc.ts` and the guard throws `EMAIL_NOT_VERIFIED` for
  unverified user and floor sessions (today: `shipping.buy`, `shipping.batchBuy`,
  `billing.checkout`, `billing.portal`). Don't re-check it in your handler.
- The top-level `src/api/router.ts` already maps every contract key to your `<name>Router`; you only
  edit your module folder. Delete the `stubRouter` spread once everything is implemented.
- Vendor portal handlers use `withVendor(tenant.companyId, ...)` so the `*_vendor_read` policies apply.

## Service pattern

```ts
export async function listOrders(tx: Tx, ctx: TenantContext, input: OrderListInput) {
  const page = keyset(orders.createdAt, orders.id, input);           // src/lib/pagination.ts
  const rows = await tx.select().from(orders).where(and(filters, page.where))
    .orderBy(...page.orderBy).limit(page.limit + 1);
  return page.result(rows, toOrder);
}
```

Map DB rows to contract shapes in a `toX()` function; the contract's output schema is the truth.

## Job pattern (`jobs.ts`)

```ts
export const pushTracking = defineJob({
  queue: "ship",                                   // sync | render | ship | ai | reports
  name: "shipping.pushTracking",                   // unique, dotted
  input: z.object({ companyId: z.uuid(), shipmentId: z.uuid() }),
  jobId: (i) => `push-tracking-${i.shipmentId}`,   // idempotency key (":" is replaced, BullMQ forbids it)
  handler: async ({ companyId, shipmentId }) => {
    await withTenant(companyId, (tx) => svc.pushTracking(tx, systemContext(companyId), shipmentId));
  },
});
onEvent("shipment.labeled", pushTracking, (e) => ({ companyId: e.companyId, shipmentId: String(e.payload.shipmentId) }));
```

- The outbox relay enqueues one job per subscription with `jobId = ${eventId}_${jobName}`; return
  `null` from the mapper to ignore an event. `job.enqueue(input)` works from anywhere, but prefer
  emitting an outbox event inside the transaction.
- A bulk builder that commits in phases (the seed, `tenancy.demo`) parks each phase's events with
  `holdOutbox(tx, companyId)` (`src/db/seed/outbox-hold.ts`) and releases them once at the end, so
  a running worker's jobs never write derived rows (`usage`, `stock_levels`, profit lines) for a
  half-built company (B-106). Only rows carrying the held marker are released. Scheduled sweeps
  (`upsertJobScheduler`) don't go through the outbox, so a bulk builder writes any row a sweep can
  also create (alerts by dedupe key, `inventory_settings`, the period's `usage`) as an upsert.
- User-visible progress: create a `jobs` row (contracts `Job`) and publish `job.progress` realtime events.
- `runJobInline(job, input)` runs a handler in tests without Redis workers.

## Test pattern

```ts
const company = await createCompany();                     // src/test/fixtures.ts
const user = await createUser(company.id, "office");
const ctx = tenantContext(company.id, user.id, "office");
const out = await withTenant(company.id, (tx) => svc.createThing(tx, ctx, input));
```

- Tests run against `invai_test` (migrated by `src/test/global-setup.ts`), files run serially.
- Every test creates its own company, so RLS is exercised for real; `truncateAll()` if you need a
  clean slate. Router-level tests: `call(router.orders.list, input, { context })` with a
  `Context` built from `anonymousContext()` + `permissionsFor(role)`.
- Redis is required only for realtime publishes (best-effort, failures are logged, not thrown).

## Mock-provider pattern (integrations)

Every external system lives in `src/integrations/<family>/<provider>/` behind the interface in
`src/integrations/types.ts`. Selection is automatic from `env.mocks.*` (a missing key = mock):

```ts
export function carrierAdapter(): CarrierAdapter {
  return env.mocks.carrier ? mockCarrier : easypostCarrier;
}
```

- The mock must be deterministic and produce schema-valid output (mock labels via imaging
  `POST /labels/mock`, mock AI via `src/ai/providers/mock.ts`).
- Adapters normalize at the edge (`NormalizedOrder`), never leak channel payloads into services, and
  store the raw payload in S3 (`rawPayloadKey`) for 30 days.
- The `imaging` client (`src/integrations/imaging/client.ts`) is typed for every endpoint; check
  `imaging.isUp()` in jobs and degrade gracefully (log, mark pending) when it is down.

## Foundation helpers

| Need | Use |
| --- | --- |
| Tenant transaction | `withTenant`, `withVendor`, `withSystem`, `afterCommit` (`src/db/client.ts`) |
| Audit row | `audit(tx, { companyId, actor, action, entityType, entityId, summary, data })` |
| Outbox event | `emit(tx, companyId, name, payload)` (typed by contracts `Events`) |
| Realtime | `publish(companyId, name, payload)` (contracts `RealtimeEvents`; wire = `RealtimeEnvelope`) |
| Jobs | `defineJob`, `onEvent`, `getJob`, `runJobInline` (`src/lib/queues.ts`) |
| S3 | `objectKey`, `presignPut/Get`, `putObject`, `getObject`, `headObject` |
| Encryption | `encryptedText()` column type, `encryptJson/decryptJson`, `randomToken`, `sha256Hex`. The key ring comes from a provider (`lib/field-keys.ts`, `FIELD_ENCRYPTION_PROVIDER`); `scoped()` awaits `initFieldEncryption()`, so modules never call it |
| Pagination | `keyset(createdAtCol, idCol, input)` |
| CSV | `parseCsvObjects`, `col(row, ...names)`, `toCsv` |
| Errors | `src/lib/errors.ts` |
| Account emails | `src/lib/auth-mail.ts`: verification, reset, account-locked and security-notice templates (en/es), `sendAuthMail` (background, never throws). Used by `src/auth.ts` |
| Account security (ADR 0025) | `src/lib/account-lockout.ts` (per-email lockout, HMAC-keyed), `src/lib/password-history.ts` (last 10 hashes), `src/lib/mfa.ts` (`isUserMfaRequired`, `mfaState`, `mfaBlocks`, `MFA_EXEMPT_PROCEDURES`). A module that makes someone an owner or admin calls `restartGraceIfNewlyRequired(userId, wasRequired)` after the change (see `modules/tenancy/service.ts` `changeRole`) |
| Person-facing emails | `src/lib/notify.ts` (ADR 0016): `sendUserEmail({ companyId, userId, kind, dedupeKey, messageId, subject, text, html, unsubscribe })` -> `{ status: "sent" | "skipped", reason? }`. It owns the send guard (one `email_sends` row per `(company, dedupe_key)`) and every gate (kill switch, active member, verified, not PIN-only, not suppressed, not a sample workspace, opted in); modules never call the mailer for a person. `get/set/listEmailPreference` (kind-keyed, default off; only `source: settings` turns on), `undoUnsubscribe`, `suppressEmail`, `emailFooter` (en/es, postal address from `MAIL_POSTAL_ADDRESS`), `buildMessageId`, `unsubscribeHeaders` |
| Signed email links | `src/lib/links.ts`: `signLink({ kind: "unsubscribe" | "click", companyId, userId, ref })` -> `${BETTER_AUTH_URL}/l/<token>` (purpose-bound HMAC, day-rounded expiry: 400 d / 30 d), `verifyLinkToken`, `safeWebPath`, `registerLinkHandler("click", fn)`. The public routes live in `src/api/links.ts` (GET never changes a preference; POST unsubscribes, idempotent; per-IP `links` bucket 60/min) and bind the token to an active membership before anything happens |
| Logging | `logger("scope")` |
