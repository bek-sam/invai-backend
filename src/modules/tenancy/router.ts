import { ROLE_PERMISSIONS } from "@invai/contracts";
import { stationTokenFromHeaders } from "../../api/context";
import { authed, pub } from "../../api/orpc";
import { auth } from "../../auth";
import { withTenant } from "../../db/client";
import { badRequest, forbidden, unauthorized } from "../../lib/errors";
import { listEmailPreferencesTx, setEmailPreferenceTx } from "../../lib/notify";
import { leaveDemo, resetDemo, startDemo } from "./demo";
import { pinLogin, resolveStationToken, revokeFloorSession } from "./floor-auth";
import * as svc from "./service";

export const meRouter = authed.me.router({
  get: authed.me.get.handler(({ context }) =>
    withTenant(context.tenant.companyId, (tx) => svc.me(tx, context)),
  ),
  switchOrg: authed.me.switchOrg.handler(async ({ input, context }) => {
    const target = context.memberships.find((m) => m.orgId === input.orgId);
    if (!target) throw forbidden("none", "Not a member of that company");
    await auth.api.setActiveOrganization({
      headers: context.headers,
      body: { organizationId: input.orgId },
    });
    const switched = {
      ...context,
      companyId: target.orgId,
      orgType: target.type,
      role: target.role,
      permissions: new Set(ROLE_PERMISSIONS[target.role]),
      tenant: {
        ...context.tenant,
        companyId: target.orgId,
        orgType: target.type,
        role: target.role,
      },
    };
    return withTenant(target.orgId, (tx) => svc.me(tx, switched));
  }),
  updateOrg: authed.me.updateOrg.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.updateOrg(tx, tenant, input)),
  ),
  /**
   * The caller's own email preferences, keyed by kind (wave 19, ADR 0016). `set` is always
   * `source: settings`: the person is the only one who can turn a kind on (src/lib/notify.ts).
   */
  notifications: authed.me.notifications.router({
    get: authed.me.notifications.get.handler(({ context: { tenant } }) => {
      if (!tenant.userId) throw forbidden("none", "A user session is required");
      const userId = tenant.userId;
      return withTenant(tenant.companyId, async (tx) => ({
        items: await listEmailPreferencesTx(tx, tenant.companyId, userId),
      }));
    }),
    set: authed.me.notifications.set.handler(({ input, context: { tenant } }) => {
      if (!tenant.userId) throw forbidden("none", "A user session is required");
      const userId = tenant.userId;
      return withTenant(tenant.companyId, async (tx) => {
        await setEmailPreferenceTx(tx, tenant.companyId, userId, input.kind, {
          on: input.on,
          source: "settings",
        });
        return { items: await listEmailPreferencesTx(tx, tenant.companyId, userId) };
      });
    }),
  }),
});

export const teamRouter = authed.team.router({
  list: authed.team.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listTeam(tx, tenant, input)),
  ),
  // Not wrapped in withTenant: it runs its own short transactions around the email send.
  invite: authed.team.invite.handler(({ input, context: { tenant } }) =>
    svc.inviteTeammate(tenant, input),
  ),
  changeRole: authed.team.changeRole.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.changeRole(tx, tenant, input)),
  ),
  deactivate: authed.team.deactivate.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) =>
      svc.setMemberStatus(tx, tenant, input.userId, "deactivated"),
    ),
  ),
  reactivate: authed.team.reactivate.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.setMemberStatus(tx, tenant, input.userId, "active")),
  ),
  setPin: authed.team.setPin.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.setUserPin(tx, tenant, input)),
  ),
  // Not wrapped in withTenant: it sends the email between two short transactions.
  resend: authed.team.resend.handler(({ input, context: { tenant } }) =>
    svc.resendInvite(tenant, input.userId),
  ),
  revoke: authed.team.revoke.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.revokeInvite(tx, tenant, input.userId)),
  ),
});

export const locationsRouter = authed.locations.router({
  list: authed.locations.list.handler(({ context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listLocations(tx)),
  ),
  create: authed.locations.create.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.createLocation(tx, tenant, input)),
  ),
  update: authed.locations.update.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.updateLocation(tx, tenant, input)),
  ),
  delete: authed.locations.delete.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.deleteLocation(tx, tenant, input.id)),
  ),
});

export const stationsRouter = authed.stations.router({
  list: authed.stations.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listStations(tx, input)),
  ),
  create: authed.stations.create.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.createStation(tx, tenant, input)),
  ),
  update: authed.stations.update.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.updateStation(tx, tenant, input)),
  ),
  issueToken: authed.stations.issueToken.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.issueToken(tx, tenant, input.id)),
  ),
  revokeToken: authed.stations.revokeToken.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.revokeToken(tx, tenant, input.id)),
  ),
});

/** Floor procedures take the station token from the header or the input (`auth: "station"`). */
export const floorRouter = pub.floor.router({
  login: pub.floor.login.handler(async ({ input, context }) => {
    const stationToken = input.stationToken ?? stationTokenFromHeaders(context.headers);
    if (!stationToken) throw badRequest("stationToken is required");
    const result = await pinLogin({ stationToken, pin: input.pin, ip: context.ip });
    return {
      sessionToken: result.token,
      expiresAt: result.expiresAt.toISOString(),
      user: result.user,
      station: result.station,
      permissions: [...ROLE_PERMISSIONS[result.user.role]],
    };
  }),
  logout: pub.floor.logout.handler(async ({ context }) => {
    const authz = context.headers.get("authorization");
    if (authz?.toLowerCase().startsWith("bearer fs1."))
      await revokeFloorSession(authz.slice(7).trim());
    return { ok: true as const };
  }),
  staff: pub.floor.staff.handler(async ({ context }) => {
    const token = stationTokenFromHeaders(context.headers);
    const station = token ? await resolveStationToken(token) : null;
    if (!station) throw unauthorized("Station token required");
    return withTenant(station.companyId, (tx) => svc.floorStaff(tx, station.companyId));
  }),
});

export const auditRouter = authed.audit.router({
  list: authed.audit.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listAudit(tx, tenant, input)),
  ),
});

export const demoRouter = authed.demo.router({
  start: authed.demo.start.handler(({ context }) => startDemo(context)),
  reset: authed.demo.reset.handler(({ context }) => resetDemo(context)),
  leave: authed.demo.leave.handler(({ context }) => leaveDemo(context)),
});
