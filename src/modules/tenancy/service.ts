import type { AuditEntry, Location, Me, Org, StationDevice, User } from "@invai/contracts";
import { AUDIT_ACTIONS, ROLE_PERMISSIONS } from "@invai/contracts";
import { and, asc, count, desc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import type { Context, TenantContext } from "../../api/context";
import { db, type Tx, withTenant } from "../../db/client";
import type { Address, Role, StationKind } from "../../db/schema";
import {
  auditLog,
  companies,
  invitations,
  locations,
  members,
  staffPins,
  stations,
  users,
} from "../../db/schema";
import { audit } from "../../lib/audit";
import { badRequest, conflict, forbidden, notFound, notImplemented } from "../../lib/errors";
import { keyset, type PageInput } from "../../lib/pagination";
import { assertWithinPlan } from "../billing/service";
import { issueStationToken, revokeStationTokens, setPin } from "./floor-auth";
import {
  cancelPendingInvitations,
  inviteExpiry,
  inviteLink,
  inviteSenders,
  pendingInvitations,
  STAFF_INVITE_DAYS,
  sendInviteEmail,
} from "./invites";
import { onboardingChecklist } from "./onboarding";

/*
 * Tenancy: who am I, the team, locations, stations, audit. Better Auth tables (users, members,
 * companies) carry no RLS, so this module scopes every query by company id explicitly and is
 * the only module allowed to read them directly.
 */

const AUDIT_ACTION_SET = new Set<string>(AUDIT_ACTIONS);

function toOrg(row: typeof companies.$inferSelect): Org {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    plan: row.type === "vendor" ? null : (row.plan ?? "trial"),
    demo: row.demo,
    createdAt: row.createdAt.toISOString(),
  };
}

type MemberRow = {
  user: typeof users.$inferSelect;
  member: typeof members.$inferSelect;
  hasPin: boolean;
};

function toUser(row: MemberRow): User {
  return {
    id: row.user.id,
    email: row.user.email,
    name: row.user.name,
    role: row.member.role,
    status: row.member.status,
    hasPin: row.hasPin,
    pinOnly: false, // TODO(T-5-4): PIN-only staff
    lastSeenAt: row.user.lastSeenAt?.toISOString() ?? null,
    createdAt: row.member.createdAt.toISOString(),
  };
}

async function memberRows(tx: Tx, companyId: string, where?: SQL) {
  const rows = await tx
    .select({
      user: users,
      member: members,
      hasPin: sql<boolean>`exists (select 1 from staff_pins p where p.user_id = ${users.id} and p.company_id = ${companyId} and p.active)`,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, companyId), where))
    .orderBy(desc(members.createdAt), desc(members.id));
  return rows;
}

/* ------------------------------------ me ------------------------------------ */

/** Build the `Me` payload for the current session. `tx` is the tenant transaction. */
export async function me(tx: Tx, ctx: Context & { tenant: TenantContext }): Promise<Me> {
  const { tenant } = ctx;
  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, tenant.companyId))
    .limit(1);
  if (!company) throw notFound("company", tenant.companyId);
  if (!tenant.userId) throw forbidden("none", "A user session is required");
  const [row] = await memberRows(tx, tenant.companyId, eq(members.userId, tenant.userId));
  if (!row) throw forbidden("none", "Not a member of this company");
  const role = tenant.role ?? row.member.role;
  return {
    user: toUser(row),
    org: toOrg(company),
    role,
    permissions: [...ROLE_PERMISSIONS[role]],
    orgs: ctx.memberships.map((m) => ({ id: m.orgId, name: m.name, type: m.type, role: m.role })),
    station: tenant.station
      ? { id: tenant.station.id, name: tenant.station.name, kind: tenant.station.kind }
      : null,
    onboarding: company.type === "vendor" ? null : await onboardingChecklist(tx, tenant.companyId),
  };
}

export async function updateOrg(
  tx: Tx,
  ctx: TenantContext,
  input: { name?: string; timezone?: string },
): Promise<Org> {
  const [row] = await db
    .update(companies)
    .set({ name: input.name, timezone: input.timezone })
    .where(eq(companies.id, ctx.companyId))
    .returning();
  if (!row) throw notFound("company", ctx.companyId);
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "company",
    entityId: ctx.companyId,
    summary: "Company settings updated",
    data: input,
  });
  return toOrg(row);
}

/* ----------------------------------- team ----------------------------------- */

export async function listTeam(
  tx: Tx,
  ctx: TenantContext,
  input: PageInput & { includeDeactivated: boolean },
) {
  const page = keyset(members.createdAt, members.id, input);
  const rows = await memberRows(
    tx,
    ctx.companyId,
    and(page.where, input.includeDeactivated ? undefined : sql`${members.status} <> 'deactivated'`),
  );
  const limited = rows.slice(0, page.limit + 1);
  const result = page.result(
    limited.map((r) => ({ ...r, id: r.member.id, createdAt: r.member.createdAt })),
    toUser,
  );
  // Pending invitations lead the first page; the cursor only walks members.
  if (input.cursor) return result;
  const invited = (await pendingInvitations(tx, ctx.companyId))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((row) => invitedUser(row));
  return { ...result, items: [...invited, ...result.items] };
}

async function getMember(tx: Tx, companyId: string, userId: string): Promise<User> {
  const [row] = await memberRows(tx, companyId, eq(members.userId, userId));
  if (!row) throw notFound("user", userId);
  return toUser(row);
}

/** A role must fit the org type: vendor orgs only have `vendor`, shops never do. */
function assertRoleFitsOrg(ctx: TenantContext, role: Role) {
  if (ctx.orgType === "vendor" && role !== "vendor")
    throw badRequest("Vendor orgs only have the vendor role");
  if (ctx.orgType === "shop" && role === "vendor")
    throw badRequest("Shops cannot have vendor members");
}

/** Only an owner may grant the owner role or change/deactivate an owner. */
function assertCanManage(ctx: TenantContext, targetRole: Role | null, newRole?: Role) {
  const touchesOwner = targetRole === "owner" || newRole === "owner";
  if (touchesOwner && ctx.role !== "owner")
    throw forbidden("team.manage", "Only an owner can grant or change the owner role");
}

async function activeOwnerCount(companyId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(members)
    .where(
      and(
        eq(members.organizationId, companyId),
        eq(members.role, "owner"),
        eq(members.status, "active"),
      ),
    );
  return row?.n ?? 0;
}

async function memberRole(companyId: string, userId: string): Promise<Role | null> {
  const [row] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.organizationId, companyId), eq(members.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/** An invitation shown as a team row until it is accepted (status `invited`, id = invitation id). */
function invitedUser(row: typeof invitations.$inferSelect, name?: string): User {
  return {
    id: row.id,
    email: row.email,
    name: name ?? row.email,
    role: row.role as Role,
    status: "invited",
    hasPin: false,
    pinOnly: false,
    lastSeenAt: null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function pendingInvitation(tx: Tx, companyId: string, id: string) {
  const [row] = await tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.id, id),
        eq(invitations.organizationId, companyId),
        eq(invitations.status, "pending"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * team.invite: invite someone by email. A Better Auth invitation (no user row until they sign
 * up) and an email with /accept-invite/<id>; accepting makes them an active member with this role.
 *
 * The email is sent with no transaction open, so a slow mail server never holds a pooled
 * connection or a row lock (idempotent-side-effect):
 *   1. `inviteUser` checks the team rules and commits a pending invitation (short transaction);
 *   2. the email is sent;
 *   3. on success a second short transaction replaces older invitations for this email and writes
 *      the audit row; on failure it deletes the new invitation and the call fails with
 *      UPSTREAM_FAILED, so "Invitation sent" always means sent.
 */
export async function inviteTeammate(
  ctx: TenantContext,
  input: { email?: string; name: string; role: Role; pinOnly?: boolean },
): Promise<User> {
  // TODO(T-5-4): PIN-only floor staff (no email) are built in T-5-4.
  if (input.pinOnly || !input.email) throw notImplemented("team.invite with pinOnly");
  const email = input.email;
  const invitation = await withTenant(ctx.companyId, (tx) =>
    inviteUser(tx, ctx, { email, name: input.name, role: input.role }),
  );
  const senders = await inviteSenders(ctx.companyId, ctx.userId);
  try {
    await sendInviteEmail(invitation.email, {
      ...senders,
      kind: "staff",
      role: input.role,
      link: inviteLink(invitation.id),
      expiresAt: invitation.expiresAt ?? inviteExpiry(STAFF_INVITE_DAYS),
    });
  } catch (err) {
    await withTenant(ctx.companyId, (tx) =>
      tx.delete(invitations).where(eq(invitations.id, invitation.id)),
    );
    throw err;
  }
  await withTenant(ctx.companyId, async (tx) => {
    await cancelPendingInvitations(tx, ctx.companyId, invitation.email, invitation.id);
    // Before invitations were real, an invite made a member row that could never sign in.
    await tx
      .delete(members)
      .where(
        and(
          eq(members.organizationId, ctx.companyId),
          eq(members.status, "invited"),
          inArray(
            members.userId,
            tx.select({ id: users.id }).from(users).where(eq(users.email, invitation.email)),
          ),
        ),
      );
    await audit(tx, {
      companyId: ctx.companyId,
      actor: ctx.actor,
      action: "team.invite",
      entityType: "invitation",
      entityId: invitation.id,
      summary: `${input.name} invited as ${input.role}`,
    });
  });
  return invitedUser(invitation, input.name);
}

/**
 * Step 1 of `inviteTeammate`: check the team rules and write a pending invitation. Sends no
 * email; the router calls `inviteTeammate`, which sends it after this transaction commits.
 */
export async function inviteUser(
  tx: Tx,
  ctx: TenantContext,
  input: { email: string; name: string; role: Role },
): Promise<typeof invitations.$inferSelect> {
  if (!ctx.userId) throw forbidden("team.manage", "Sign in as a person to invite teammates");
  assertRoleFitsOrg(ctx, input.role);
  assertCanManage(ctx, null, input.role);
  const email = input.email.trim().toLowerCase();
  // users carries no RLS (Better Auth table), so the app role can look it up directly.
  const [existing] = await tx
    .select({ status: members.status })
    .from(users)
    .innerJoin(members, eq(members.userId, users.id))
    .where(and(eq(users.email, email), eq(members.organizationId, ctx.companyId)))
    .limit(1);
  if (existing && existing.status !== "invited")
    throw conflict("That person is already on the team");
  // A pending invite holds a seat; re-inviting the same email replaces it, so it isn't counted.
  await assertWithinPlan(tx, ctx, "users", 1, { exceptInviteEmail: email });
  const [invitation] = await tx
    .insert(invitations)
    .values({
      organizationId: ctx.companyId,
      email,
      role: input.role,
      status: "pending",
      inviterId: ctx.userId,
      expiresAt: inviteExpiry(STAFF_INVITE_DAYS),
    })
    .returning();
  if (!invitation) throw new Error("invitation insert failed");
  return invitation;
}

export async function changeRole(
  tx: Tx,
  ctx: TenantContext,
  input: { userId: string; role: Role },
): Promise<User> {
  if (input.userId === ctx.userId) throw badRequest("You cannot change your own role");
  assertRoleFitsOrg(ctx, input.role);
  const current = await memberRole(ctx.companyId, input.userId);
  if (!current) {
    // A pending invitation in the team list: change the role they will join with.
    const invitation = await pendingInvitation(tx, ctx.companyId, input.userId);
    if (!invitation) throw notFound("user", input.userId);
    assertCanManage(ctx, invitation.role as Role, input.role);
    const [row] = await tx
      .update(invitations)
      .set({ role: input.role })
      .where(eq(invitations.id, invitation.id))
      .returning();
    if (!row) throw notFound("user", input.userId);
    return invitedUser(row);
  }
  assertCanManage(ctx, current, input.role);
  if (current === "owner" && input.role !== "owner" && (await activeOwnerCount(ctx.companyId)) <= 1)
    throw conflict("A company needs at least one owner");
  const [row] = await db
    .update(members)
    .set({ role: input.role })
    .where(and(eq(members.organizationId, ctx.companyId), eq(members.userId, input.userId)))
    .returning({ id: members.id });
  if (!row) throw notFound("user", input.userId);
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "team.role_changed",
    entityType: "user",
    entityId: input.userId,
    summary: `Role changed to ${input.role}`,
    data: { from: current, to: input.role },
  });
  return getMember(tx, ctx.companyId, input.userId);
}

export async function setMemberStatus(
  tx: Tx,
  ctx: TenantContext,
  userId: string,
  status: "active" | "deactivated",
) {
  if (userId === ctx.userId) throw badRequest("You cannot deactivate yourself");
  const current = await memberRole(ctx.companyId, userId);
  if (!current) {
    // Deactivating a pending invitation cancels it, so its link stops working.
    const invitation =
      status === "deactivated" ? await pendingInvitation(tx, ctx.companyId, userId) : null;
    if (!invitation) throw notFound("user", userId);
    assertCanManage(ctx, invitation.role as Role);
    await tx
      .update(invitations)
      .set({ status: "canceled" })
      .where(eq(invitations.id, invitation.id));
    await audit(tx, {
      companyId: ctx.companyId,
      actor: ctx.actor,
      action: "team.deactivated",
      entityType: "invitation",
      entityId: invitation.id,
      summary: "Invitation canceled",
    });
    return { ...invitedUser(invitation), status: "deactivated" as const };
  }
  assertCanManage(ctx, current);
  if (
    status === "deactivated" &&
    current === "owner" &&
    (await activeOwnerCount(ctx.companyId)) <= 1
  )
    throw conflict("A company needs at least one owner");
  const [row] = await db
    .update(members)
    .set({ status })
    .where(and(eq(members.organizationId, ctx.companyId), eq(members.userId, userId)))
    .returning({ id: members.id });
  if (!row) throw notFound("user", userId);
  if (status === "deactivated") {
    await tx.update(staffPins).set({ active: false }).where(eq(staffPins.userId, userId));
  }
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "team.deactivated",
    entityType: "user",
    entityId: userId,
    summary: status === "deactivated" ? "Deactivated" : "Reactivated",
  });
  return getMember(tx, ctx.companyId, userId);
}

export async function setUserPin(
  tx: Tx,
  ctx: TenantContext,
  input: { userId: string; pin: string },
) {
  if (
    !(await memberRole(ctx.companyId, input.userId)) &&
    (await pendingInvitation(tx, ctx.companyId, input.userId))
  )
    throw badRequest("Set a PIN after they accept the invite");
  const target = await getMember(tx, ctx.companyId, input.userId);
  assertCanManage(ctx, target.role);
  await setPin(tx, {
    companyId: ctx.companyId,
    userId: input.userId,
    pin: input.pin,
    actorUserId: ctx.userId,
  });
  return { ok: true as const };
}

/** Names of active members with a PIN, for the tablet's PIN screen. */
export async function floorStaff(tx: Tx, companyId: string) {
  const rows = await tx
    .select({ id: users.id, name: users.name, role: members.role })
    .from(staffPins)
    .innerJoin(users, eq(users.id, staffPins.userId))
    .innerJoin(members, and(eq(members.userId, users.id), eq(members.organizationId, companyId)))
    .where(and(eq(staffPins.active, true), eq(members.status, "active")))
    .orderBy(asc(users.name));
  return { items: rows };
}

/* --------------------------------- locations --------------------------------- */

function toLocation(row: typeof locations.$inferSelect): Location {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listLocations(tx: Tx) {
  const rows = await tx
    .select()
    .from(locations)
    .orderBy(desc(locations.isDefault), asc(locations.name));
  return { items: rows.map(toLocation) };
}

export async function defaultLocationId(tx: Tx): Promise<string> {
  const [row] = await tx
    .select({ id: locations.id })
    .from(locations)
    .orderBy(desc(locations.isDefault), asc(locations.createdAt))
    .limit(1);
  if (!row) throw badRequest("Create a location first");
  return row.id;
}

export async function createLocation(
  tx: Tx,
  ctx: TenantContext,
  input: { name: string; address: Address | null; isDefault: boolean },
) {
  if (input.isDefault) await tx.update(locations).set({ isDefault: false });
  const [row] = await tx
    .insert(locations)
    .values({
      companyId: ctx.companyId,
      name: input.name,
      address: input.address,
      isDefault: input.isDefault,
    })
    .returning();
  if (!row) throw new Error("location insert failed");
  return toLocation(row);
}

export async function updateLocation(
  tx: Tx,
  _ctx: TenantContext,
  input: { id: string; name?: string; address?: Address | null; isDefault?: boolean },
) {
  if (input.isDefault) await tx.update(locations).set({ isDefault: false });
  const [row] = await tx
    .update(locations)
    .set({ name: input.name, address: input.address, isDefault: input.isDefault })
    .where(eq(locations.id, input.id))
    .returning();
  if (!row) throw notFound("location", input.id);
  return toLocation(row);
}

export async function deleteLocation(tx: Tx, _ctx: TenantContext, id: string) {
  const [inUse] = await tx.select({ n: count() }).from(stations).where(eq(stations.locationId, id));
  if ((inUse?.n ?? 0) > 0) throw conflict("Location still has stations");
  const deleted = await tx
    .delete(locations)
    .where(eq(locations.id, id))
    .returning({ id: locations.id });
  if (deleted.length === 0) throw notFound("location", id);
  return { ok: true as const };
}

/* ---------------------------------- stations ---------------------------------- */

function toStation(row: typeof stations.$inferSelect): StationDevice {
  return {
    id: row.id,
    name: row.name,
    locationId: row.locationId,
    kind: row.kind,
    active: row.active,
    tokenIssuedAt: row.tokenIssuedAt?.toISOString() ?? null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listStations(tx: Tx, input: { locationId?: string }) {
  const rows = await tx
    .select()
    .from(stations)
    .where(input.locationId ? eq(stations.locationId, input.locationId) : undefined)
    .orderBy(asc(stations.name));
  return { items: rows.map(toStation) };
}

export async function createStation(
  tx: Tx,
  ctx: TenantContext,
  input: { name: string; locationId: string; kind: StationKind | null },
) {
  const [row] = await tx
    .insert(stations)
    .values({
      companyId: ctx.companyId,
      name: input.name,
      locationId: input.locationId,
      kind: input.kind,
    })
    .returning();
  if (!row) throw new Error("station insert failed");
  return toStation(row);
}

export async function updateStation(
  tx: Tx,
  _ctx: TenantContext,
  input: {
    id: string;
    name?: string;
    locationId?: string;
    kind?: StationKind | null;
    active?: boolean;
  },
) {
  const [row] = await tx
    .update(stations)
    .set({ name: input.name, locationId: input.locationId, kind: input.kind, active: input.active })
    .where(eq(stations.id, input.id))
    .returning();
  if (!row) throw notFound("station", input.id);
  return toStation(row);
}

export async function issueToken(tx: Tx, ctx: TenantContext, stationId: string) {
  const [row] = await tx
    .select({ id: stations.id })
    .from(stations)
    .where(eq(stations.id, stationId))
    .limit(1);
  if (!row) throw notFound("station", stationId);
  const { token } = await issueStationToken(tx, {
    companyId: ctx.companyId,
    stationId,
    userId: ctx.userId,
  });
  return { stationId, token, expiresAt: null };
}

export async function revokeToken(tx: Tx, ctx: TenantContext, stationId: string) {
  await revokeStationTokens(tx, { companyId: ctx.companyId, stationId });
  return { ok: true as const };
}

/* ----------------------------------- audit ----------------------------------- */

export type AuditListInput = PageInput & {
  action?: string;
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
};

export async function listAudit(tx: Tx, _ctx: TenantContext, input: AuditListInput) {
  const page = keyset(auditLog.createdAt, auditLog.id, input);
  const filters: (SQL | undefined)[] = [page.where];
  if (input.action) filters.push(eq(auditLog.action, input.action));
  if (input.actorUserId) filters.push(eq(auditLog.actorUserId, input.actorUserId));
  if (input.entityType) filters.push(eq(auditLog.entityType, input.entityType));
  if (input.entityId) filters.push(eq(auditLog.entityId, input.entityId));
  if (input.from) filters.push(gte(auditLog.createdAt, new Date(input.from)));
  if (input.to) filters.push(lte(auditLog.createdAt, new Date(input.to)));
  const rows = await tx
    .select()
    .from(auditLog)
    .where(and(...filters))
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  const userIds = [...new Set(rows.map((r) => r.actorUserId).filter((v): v is string => !!v))];
  const names = userIds.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const nameBy = new Map(names.map((n) => [n.id, n.name]));
  return page.result(
    rows,
    (r): AuditEntry => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      action: (AUDIT_ACTION_SET.has(r.action)
        ? r.action
        : "settings.changed") as AuditEntry["action"],
      actor: {
        userId: r.actorUserId,
        name: r.actorUserId
          ? (nameBy.get(r.actorUserId) ?? "Unknown")
          : r.actorKind === "station"
            ? "Station"
            : "System",
        stationId: r.stationId,
      },
      entityType: r.entityType ?? "",
      entityId: r.entityId,
      summary: r.summary,
      meta: r.data,
    }),
  );
}
