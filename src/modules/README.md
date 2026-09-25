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
| Encryption | `encryptedText()` column type, `encryptJson/decryptJson`, `randomToken`, `sha256Hex` |
| Pagination | `keyset(createdAtCol, idCol, input)` |
| CSV | `parseCsvObjects`, `col(row, ...names)`, `toCsv` |
| Errors | `src/lib/errors.ts` |
| Account emails | `src/lib/auth-mail.ts`: verification, reset and security-notice templates (en/es), `sendAuthMail` (background, never throws). Used by `src/auth.ts` |
| Logging | `logger("scope")` |
