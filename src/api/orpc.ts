import {
  CONTRACT_VERSION_HEADER,
  contract,
  isContractVersionAtLeast,
  type ProcedureMeta,
} from "@invai/contracts";
import { type AnyContractRouter, isContractProcedure } from "@orpc/contract";
import { implement, type Router } from "@orpc/server";
import { env } from "../env";
import {
  clientTooOld,
  emailNotVerified,
  forbidden,
  mfaRequired,
  notImplemented,
  rateLimited,
  unauthorized,
} from "../lib/errors";
import { MFA_EXEMPT_PROCEDURES, mfaBlocks } from "../lib/mfa";
import { checkRateLimit, type RateBucket } from "../lib/ratelimit";
import { sanitizeDeep } from "../lib/text-safety";
import { type Context, type TenantContext, tenantOf } from "./context";

/*
 * oRPC base builders. Every module router is built from these:
 *
 *   import { authed, pub, stubRouter } from "../../api/orpc";
 *   export const designsRouter = authed.designs.router({
 *     ...stubRouter(authed.designs, contract.designs, ["designs"]),   // NOT_IMPLEMENTED fillers
 *     list: authed.designs.list.handler(({ input, context }) =>
 *       withTenant(context.tenant.companyId, (tx) => listDesigns(tx, context.tenant, input))),
 *   });
 *
 * `pub`  runs the auth-mode + permission guard from each procedure's contract meta.
 * `authed` additionally guarantees `context.tenant` (company, role, permissions, actor).
 * Use `pub` only for procedures whose meta says `auth: "public"` or `auth: "station"`.
 */

export const os = implement(contract).$context<Context>();

/**
 * Procedures that move money: they need a verified email on top of the permission (T-2-3). Label
 * buys (web and floor) and Stripe checkout and portal. Connecting a channel is deliberately not
 * here: it's a new shop's first step and spends nothing.
 */
export const EMAIL_VERIFIED_PROCEDURES: ReadonlySet<string> = new Set([
  "shipping.buy",
  "shipping.batchBuy",
  "billing.checkout",
  "billing.portal",
]);

/**
 * NUL-safe input at the API boundary (T-8-6, follow-up to T-8-2 r3 / OI-5): a raw NUL byte (or
 * other C0 control character, or a lone UTF-16 surrogate) in any caller-supplied string crashes
 * the first Postgres text/jsonb write it reaches (22P05/22021), wherever that happens to be.
 * Fixing call sites one at a time doesn't close the class, so this sanitizes every string field
 * of every procedure's input, once, here.
 *
 * Why a middleware and not a shared schema helper in contracts: every procedure's `.input()` in
 * `@invai/contracts` is `z.object(...)` (or a `z.union` of them) — there is no bare-string or
 * bare-array input anywhere in the contract. That means the *validated* input handed to this
 * middleware is always a plain object, so one middleware can sanitize it in place instead of
 * wrapping every `z.string()` call in every schema file with a `SanitizedString` helper (dozens
 * of call sites across `contracts/src/schemas/*.ts`, for the same outcome).
 *
 * `next()` in oRPC only lets a middleware replace `context`, not `input` (see `MiddlewareNextFn`
 * in `@orpc/server`): there's no way to swap the top-level input object for a sanitized copy. So
 * this mutates the validated input's own enumerable properties instead of reassigning it — since
 * every middleware after this one, and the handler, close over the same object reference, they
 * see the sanitized values. `sanitizeDeep` (shared with the AI gateway and the order-import
 * pipeline, `../lib/text-safety`) already builds that sanitized tree immutably; `Object.assign`
 * just copies its top-level keys onto the object already flowing through the chain.
 *
 * Attached first (before `guard`), so permission/auth checks and every handler see clean input.
 * The AI gateway's `sanitizeDeep`/`sanitizeText` (T-8-2) and `ask()`'s sanitizing stay as defense
 * in depth for AI-specific text that's stored or sent to the model beyond the raw request input.
 */
const sanitizeInput = os.middleware(async ({ next }, input: unknown) => {
  if (input && typeof input === "object") {
    Object.assign(input as Record<string, unknown>, sanitizeDeep(input));
  }
  return next();
});

/**
 * Floor API version handshake (T-13-1, B-82, ADR 0012). A floor tablet sends `X-Contract-Version`
 * on every call; below `MIN_FLOOR_CONTRACT_VERSION` (or with no header) its `floor`/`station`
 * calls get `CLIENT_TOO_OLD` (426) so an old tablet can't write old shapes after a deploy.
 * `station` covers `floor.login`/`floor.staff`, so the tablet hears it at first contact.
 * A web user session calling an `auth: "floor"` procedure is exempt: the gate is for tablets.
 * Runs after the auth-mode check, so an anonymous call to a floor procedure is still a 401.
 */
export function enforceFloorContractVersion(
  mode: NonNullable<ProcedureMeta["auth"]>,
  context: Pick<Context, "headers" | "sessionKind">,
  minVersion: string = env.MIN_FLOOR_CONTRACT_VERSION,
): void {
  if (mode !== "floor" && mode !== "station") return;
  if (context.sessionKind === "user") return;
  const current = context.headers.get(CONTRACT_VERSION_HEADER)?.trim() || null;
  if (!isContractVersionAtLeast(current, minVersion)) throw clientTooOld(minVersion, current);
}

const guard = os.middleware(async ({ context, next, procedure, path }) => {
  const meta = procedure["~orpc"].meta as ProcedureMeta;
  const mode = meta.auth ?? "user";

  switch (mode) {
    case "public":
    case "station":
      // `station` procedures take the token from the header or the input; handlers validate it.
      break;
    case "user":
      if (context.sessionKind !== "user" || !context.companyId) throw unauthorized();
      break;
    case "floor":
      if (
        !(context.sessionKind === "user" || context.sessionKind === "floor") ||
        !context.companyId
      ) {
        throw unauthorized();
      }
      break;
  }

  enforceFloorContractVersion(mode, context);

  if (meta.permission !== "none" && !context.permissions.has(meta.permission)) {
    throw forbidden(meta.permission, `Missing permission ${meta.permission} for ${path.join(".")}`);
  }
  // Required two-step sign-in (T-28-2, ADR 0025): web sessions only, never public or station
  // procedures; floor PIN sessions carry no `mfa`.
  if (
    context.sessionKind === "user" &&
    (mode === "user" || mode === "floor") &&
    !MFA_EXEMPT_PROCEDURES.has(path.join(".")) &&
    mfaBlocks(context.mfa)
  ) {
    throw mfaRequired(context.mfa?.deadline ?? null);
  }
  if (EMAIL_VERIFIED_PROCEDURES.has(path.join(".")) && !context.emailVerified) {
    throw emailNotVerified();
  }
  return next();
});

/**
 * Per-company API rate limits (T-12-3, B-20): a Valkey token bucket keyed by `company_id`, not
 * IP (see `lib/ratelimit.ts`). Runs after `guard` so a request that would 401/403 anyway doesn't
 * spend a token. Skipped when there's no company yet (public procedures, or a station/floor
 * request whose token didn't resolve) -- nothing to key the bucket on.
 *
 * Bucket: `ai.*` procedures get the `ai` bucket (the AI gateway's own per-company spend breaker
 * covers cost; this covers request volume), except the cheap reads in `AI_CHEAP_READS`, which
 * never call a model and go to `reads` (B-133: the web's credit-balance polling used to drain the
 * 20/min `ai` bucket and block the assistant's `ask`); `auth: "station"` procedures (floor PIN
 * login, the PIN-screen staff list) get `auth`; everything else is `reads` for GET, `writes`
 * otherwise. `RATE_LIMITED`'s `retryAfterSec` becomes both the error's `data` (already in
 * COMMON_ERRORS) and an HTTP `Retry-After` header, via `context.resHeaders`
 * (`ResponseHeadersPlugin`, api/app.ts) -- that plugin merges headers set on `context.resHeaders`
 * into the response even when the middleware that set them goes on to throw.
 */
export const AI_CHEAP_READS: ReadonlySet<string> = new Set([
  "ai.credits.balance",
  "ai.credits.ledger",
  "ai.assistant.conversations",
  "ai.assistant.conversation",
]);

/**
 * Non-GET procedures that are a pure, side-effect-free read (T-P3-1, B-236; root cause
 * `waves/P2/reports/gate-rootcause.md`): a body param forces REST method POST/PATCH/PUT even
 * though nothing is written, so the old `method === "GET" ? "reads" : "writes"` rule put them
 * in `writes` alongside real mutations. `files.downloadUrl` is the one that broke the floor:
 * the thumbnail list calls it once per item, draining the 120/min `writes` bucket and 429'ing
 * the next real `production.scan` right behind it.
 *
 * This set was built by walking every non-GET procedure whose permission ends in `.read`
 * (`contract-dump` in the report) and reading its handler. Each entry here has no DB write, no
 * outbox emit, no job enqueue, no signed upload and no outbound/paid call -- see
 * `src/api/buckets.test.ts` for the full walk, including the "stays writes" list with a reason
 * for every procedure that looked like a read by permission but isn't one in effect.
 * `ai.*` and `auth: "station"` procedures are untouched (AC2): they're governed by
 * `AI_CHEAP_READS` and the `auth` bucket respectively, decided before this set is even checked.
 */
export const NON_GET_READS: ReadonlySet<string> = new Set([
  // Presigns a GET url for a file that already exists in storage. No write.
  "files.downloadUrl",
  // Dry-runs a SKU rule's pattern against one sample string: regex capture + an in-memory
  // catalog-index lookup, no DB write.
  "skuRules.test",
  // Reads unmapped order items and the catalog index to propose mappings; computes and returns,
  // never persists a rule or a mapping.
  "skuRules.suggest",
  // Counts compositions, images and credits for a photo-set spec; no write, no job, no call.
  "photos.estimate",
]);

/** Non-`ai.*` procedures that spend AI credits or call a model provider (ADR 0023 §8). */
export const AI_BUCKET_PROCEDURES: ReadonlySet<string> = new Set([
  "photos.analyzeDesign",
  "photos.createSet",
  "photos.pushToShopify",
]);

export function bucketFor(
  path: readonly string[],
  meta: ProcedureMeta,
  method: string | undefined,
): RateBucket {
  if (path[0] === "ai") return AI_CHEAP_READS.has(path.join(".")) ? "reads" : "ai";
  if (AI_BUCKET_PROCEDURES.has(path.join("."))) return "ai";
  if (meta.auth === "station") return "auth";
  if (method === "GET") return "reads";
  return NON_GET_READS.has(path.join(".")) ? "reads" : "writes";
}

const rateLimit = os.middleware(async ({ context, next, procedure, path }) => {
  if (!context.companyId) return next();
  const meta = procedure["~orpc"].meta as ProcedureMeta;
  const method = (procedure["~orpc"].route as { method?: string } | undefined)?.method;
  const bucket = bucketFor(path, meta, method);
  const { allowed, retryAfterSec } = await checkRateLimit(bucket, context.companyId);
  if (!allowed) {
    context.resHeaders?.set("Retry-After", String(retryAfterSec));
    throw rateLimited(retryAfterSec);
  }
  return next();
});

/** Guarded builder without a tenant requirement. Sanitizes input before the permission guard. */
export const pub = os.use(sanitizeInput).use(guard).use(rateLimit);

/** Guarded builder that adds `context.tenant: TenantContext`. */
export const authed = pub.use(async ({ context, next }) => {
  if (!context.companyId || !context.orgType || !context.sessionKind) throw unauthorized();
  const tenant: TenantContext = tenantOf(context);
  return next({ context: { tenant } });
});

export type AuthedContext = Context & { tenant: TenantContext };

/**
 * Build NOT_IMPLEMENTED handlers for every procedure under a contract node. Spread the result
 * into `router({...})` and override the procedures you implement; typecheck stays green while
 * the module is in progress and the client gets a clear 501 for the rest.
 */
export function stubRouter<T extends AnyContractRouter>(
  impl: unknown,
  node: T,
  path: string[] = [],
): StubRouter<T> {
  if (isContractProcedure(node)) {
    const name = path.join(".");
    const procedureImpl = impl as { handler: (fn: () => never) => unknown };
    return procedureImpl.handler(() => {
      throw notImplemented(name);
    }) as StubRouter<T>;
  }
  const implRecord = impl as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(node as Record<string, AnyContractRouter>).map(([key, child]) => [
      key,
      stubRouter(implRecord[key], child, [...path, key]),
    ]),
  ) as StubRouter<T>;
}

export type StubRouter<T extends AnyContractRouter> = Router<T, Context>;
