import { contract, type ProcedureMeta } from "@invai/contracts";
import { type AnyContractRouter, isContractProcedure } from "@orpc/contract";
import { implement, type Router } from "@orpc/server";
import { forbidden, notImplemented, unauthorized } from "../lib/errors";
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

  if (meta.permission !== "none" && !context.permissions.has(meta.permission)) {
    throw forbidden(meta.permission, `Missing permission ${meta.permission} for ${path.join(".")}`);
  }
  return next();
});

/** Guarded builder without a tenant requirement. */
export const pub = os.use(guard);

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
