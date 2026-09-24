import { type Permission, ROLE_PERMISSIONS } from "@invai/contracts";
import { and, eq } from "drizzle-orm";
import { auth } from "../auth";
import { db, withTenant } from "../db/client";
import type { CompanyType, Role, StationKind } from "../db/schema";
import { companies, members, stations, users } from "../db/schema";
import type { Actor } from "../lib/audit";
import { logger } from "../lib/log";
import {
  isFloorSessionRevoked,
  isStationTokenLive,
  resolveStationToken,
  verifyFloorSessionToken,
} from "../modules/tenancy/floor-auth";

const log = logger("context");

export type SessionKind = "user" | "floor" | "station";

export type StationInfo = { id: string; name: string; kind: StationKind | null; tokenId: string };
export type Membership = { orgId: string; name: string; type: CompanyType; role: Role };

/** Built once per request from the cookie session, a floor session or a station token. */
export type Context = {
  requestId: string;
  ip: string | null;
  headers: Headers;
  sessionKind: SessionKind | null;
  user: { id: string; name: string; email: string } | null;
  companyId: string | null;
  orgType: CompanyType | null;
  role: Role | null;
  permissions: ReadonlySet<Permission>;
  station: StationInfo | null;
  /** Every org the user belongs to (user sessions only). */
  memberships: Membership[];
  /** The Better Auth session id for user sessions (used by me.switchOrg). */
  authSessionId: string | null;
};

/** What every authenticated handler works with. See `authed` in src/api/orpc.ts. */
export type TenantContext = {
  companyId: string;
  orgType: CompanyType;
  userId: string | null;
  role: Role | null;
  permissions: ReadonlySet<Permission>;
  sessionKind: SessionKind;
  station: StationInfo | null;
  user: Context["user"];
  actor: Actor;
};

const NO_PERMISSIONS: ReadonlySet<Permission> = new Set();

export function anonymousContext(headers: Headers, ip: string | null): Context {
  return {
    requestId: crypto.randomUUID(),
    ip,
    headers,
    sessionKind: null,
    user: null,
    companyId: null,
    orgType: null,
    role: null,
    permissions: NO_PERMISSIONS,
    station: null,
    memberships: [],
    authSessionId: null,
  };
}

export function permissionsFor(role: Role | null): ReadonlySet<Permission> {
  return role ? new Set(ROLE_PERMISSIONS[role]) : NO_PERMISSIONS;
}

/** Vendor orgs only carry the `vendor` role and shops never do; anything else gets no permissions. */
export function roleFits(orgType: CompanyType, role: Role): boolean {
  return orgType === "vendor" ? role === "vendor" : role !== "vendor";
}

export function clientIp(headers: Headers): string | null {
  const fwd = headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() ?? headers.get("x-real-ip") ?? null;
}

/** The station token from `Authorization: Station <token>` (or `X-Station-Token`). */
export function stationTokenFromHeaders(headers: Headers): string | null {
  const authz = headers.get("authorization");
  if (authz?.toLowerCase().startsWith("station ")) return authz.slice(8).trim();
  return headers.get("x-station-token");
}

export async function buildContext(request: Request): Promise<Context> {
  const headers = request.headers;
  const ctx = anonymousContext(headers, clientIp(headers));
  const authz = headers.get("authorization");

  try {
    if (authz?.toLowerCase().startsWith("bearer fs1.")) {
      return (await floorContext(ctx, authz.slice(7).trim())) ?? ctx;
    }
    const stationToken = stationTokenFromHeaders(headers);
    if (stationToken) {
      return (await stationContext(ctx, stationToken)) ?? ctx;
    }
    return (await userContext(ctx, headers)) ?? ctx;
  } catch (err) {
    log.warn("context build failed", { error: String(err) });
    return ctx;
  }
}

async function floorContext(ctx: Context, token: string): Promise<Context | null> {
  const session = verifyFloorSessionToken(token);
  if (!session) return null;
  if (await isFloorSessionRevoked(token)) return null;
  if (!(await isStationTokenLive(session.companyId, session.stationTokenId))) return null;
  const [company] = await db
    .select({ type: companies.type })
    .from(companies)
    .where(eq(companies.id, session.companyId))
    .limit(1);
  // Role and status come from the live membership, so a role change or deactivation applies to
  // floor sessions at once instead of when the signed token expires.
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: members.role })
    .from(users)
    .innerJoin(members, eq(members.userId, users.id))
    .where(
      and(
        eq(users.id, session.userId),
        eq(members.organizationId, session.companyId),
        eq(members.status, "active"),
      ),
    )
    .limit(1);
  if (!company || !user) return null;
  const station = await withTenant(session.companyId, async (tx) => {
    const [s] = await tx
      .select({ id: stations.id, name: stations.name, kind: stations.kind })
      .from(stations)
      .where(eq(stations.id, session.stationId))
      .limit(1);
    return s ?? null;
  });
  if (!station) return null;
  return {
    ...ctx,
    sessionKind: "floor",
    user: { id: user.id, name: user.name, email: user.email },
    companyId: session.companyId,
    orgType: company.type,
    role: user.role,
    permissions: roleFits(company.type, user.role) ? permissionsFor(user.role) : NO_PERMISSIONS,
    station: { ...station, tokenId: session.stationTokenId },
  };
}

async function stationContext(ctx: Context, token: string): Promise<Context | null> {
  const session = await resolveStationToken(token);
  if (!session?.station.active) return null;
  const [company] = await db
    .select({ type: companies.type })
    .from(companies)
    .where(eq(companies.id, session.companyId))
    .limit(1);
  if (!company) return null;
  return {
    ...ctx,
    sessionKind: "station",
    companyId: session.companyId,
    orgType: company.type,
    station: { ...session.station, tokenId: session.tokenId },
  };
}

async function userContext(ctx: Context, headers: Headers): Promise<Context | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const memberships = await db
    .select({
      orgId: members.organizationId,
      name: companies.name,
      type: companies.type,
      role: members.role,
      status: members.status,
    })
    .from(members)
    .innerJoin(companies, eq(companies.id, members.organizationId))
    .where(and(eq(members.userId, session.user.id), eq(members.status, "active")))
    .orderBy(members.createdAt);
  const activeId = session.session.activeOrganizationId ?? null;
  const active = memberships.find((m) => m.orgId === activeId) ?? memberships[0] ?? null;
  return {
    ...ctx,
    sessionKind: "user",
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    companyId: active?.orgId ?? null,
    orgType: active?.type ?? null,
    role: active?.role ?? null,
    permissions:
      active && roleFits(active.type, active.role) ? permissionsFor(active.role) : NO_PERMISSIONS,
    memberships: memberships.map(({ orgId, name, type, role }) => ({ orgId, name, type, role })),
    authSessionId: session.session.id,
  };
}

/** A TenantContext for background jobs and seeds: no user, system actor. */
export function systemContext(companyId: string, orgType: CompanyType = "shop"): TenantContext {
  return {
    companyId,
    orgType,
    userId: null,
    role: null,
    permissions: NO_PERMISSIONS,
    sessionKind: "station",
    station: null,
    user: null,
    actor: { kind: "system" },
  };
}

/** Narrow a Context to a TenantContext (throws when there is no company). */
export function tenantOf(ctx: Context): TenantContext {
  if (!ctx.companyId || !ctx.orgType || !ctx.sessionKind) {
    throw new Error("tenantOf() called without an authenticated company");
  }
  return {
    companyId: ctx.companyId,
    orgType: ctx.orgType,
    userId: ctx.user?.id ?? null,
    role: ctx.role,
    permissions: ctx.permissions,
    sessionKind: ctx.sessionKind,
    station: ctx.station,
    user: ctx.user,
    actor: {
      kind: ctx.user ? "user" : "station",
      userId: ctx.user?.id ?? null,
      stationId: ctx.station?.id ?? null,
      ip: ctx.ip,
    },
  };
}
