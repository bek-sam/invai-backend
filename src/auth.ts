import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthEndpoint } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, ownerAc } from "better-auth/plugins/organization/access";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/client";
import {
  accounts,
  companies,
  invitations,
  members,
  sessions,
  users,
  verifications,
} from "./db/schema";
import { env } from "./env";
import { invitePreview } from "./modules/tenancy/invites";
import { onOrganizationCreated } from "./modules/today/org-hooks";

/*
 * Better Auth: email + password, companies are organizations (`companies` table with a `type`
 * column: shop | vendor), members carry the InvAI role. Better Auth's own access control only
 * governs its organization endpoints (invite, remove member...); procedure permissions come from
 * contracts ROLE_PERMISSIONS and are checked in src/api/orpc.ts.
 */

const ac = createAccessControl(defaultStatements);
const staff = ac.newRole({ organization: [], member: [], invitation: [], team: [] });

export const authRoles = {
  owner: ac.newRole(ownerAc.statements),
  admin: ac.newRole(adminAc.statements),
  office: staff,
  designer: staff,
  presser: staff,
  packer: staff,
  receiver: staff,
  vendor: ac.newRole(adminAc.statements),
};

/**
 * Better Auth organization endpoints the apps never call. Team, role and org changes go through
 * the InvAI procedures (team.*, me.updateOrg), which enforce owner rules and write audit rows;
 * leaving these open would let an admin promote or remove owners, or edit `plan`, around them.
 * The web app only uses organization/create, list and set-active, plus accept-invitation for the
 * invitations team.invite and vendors.invite create (src/modules/tenancy/invites.ts).
 */
export const DISABLED_AUTH_PATHS = [
  "/organization/update",
  "/organization/delete",
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/update-member-role",
  "/organization/remove-member",
  "/organization/leave",
  "/organization/create-role",
  "/organization/update-role",
  "/organization/delete-role",
  "/organization/create-team",
  "/organization/update-team",
  "/organization/remove-team",
  "/organization/add-team-member",
  "/organization/remove-team-member",
  "/organization/set-active-team",
  // Member and invitation listings (emails) belong behind team.read.
  "/organization/list-members",
  "/organization/get-full-organization",
  "/organization/list-invitations",
];

/**
 * GET /api/auth/invite-preview?id=<invitationId>: what the accept-invite page shows before anyone
 * signs in (company, role, the invited email, whether that email already has an account). The id
 * is only in the invite email; anything but a pending invitation returns just its status.
 */
const invitePreviewPlugin = {
  id: "invai-invite-preview",
  endpoints: {
    invitePreview: createAuthEndpoint(
      "/invite-preview",
      { method: "GET", query: z.object({ id: z.string().max(64) }) },
      async (ctx) => ctx.json(await invitePreview(ctx.query.id)),
    ),
  },
} satisfies BetterAuthPlugin;

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { users, sessions, accounts, verifications, companies, members, invitations },
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.WEB_ORIGIN, env.FLOOR_ORIGIN],
  emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
  disabledPaths: DISABLED_AUTH_PATHS,
  // Per-IP limits on the auth endpoints (Better Auth only enables them in production by default).
  rateLimit: {
    enabled: !env.isTest,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 20 }, // per IP; a shop office shares one IP
      "/sign-up/email": { window: 60, max: 5 },
      "/organization/create": { window: 60, max: 5 },
      "/invite-preview": { window: 60, max: 30 },
      "/organization/accept-invitation": { window: 60, max: 10 },
    },
  },
  user: { modelName: "users" },
  session: {
    modelName: "sessions",
    expiresIn: 60 * 60 * 24 * 14,
    updateAge: 60 * 60 * 24,
  },
  account: { modelName: "accounts" },
  verification: { modelName: "verifications" },
  advanced: {
    database: { generateId: "uuid" },
    useSecureCookies: env.isProd,
    defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: env.isProd },
  },
  databaseHooks: {
    session: {
      create: {
        // A fresh session starts in the user's first company so `me.get` works right away.
        before: async (session) => {
          const [membership] = await db
            .select({ organizationId: members.organizationId })
            .from(members)
            .where(eq(members.userId, session.userId))
            .orderBy(members.createdAt)
            .limit(1);
          return {
            data: { ...session, activeOrganizationId: membership?.organizationId ?? null },
          };
        },
      },
    },
  },
  plugins: [
    organization({
      ac,
      roles: authRoles,
      creatorRole: "owner",
      allowUserToCreateOrganization: true,
      // Emails aren't verified at sign-up. The invitation id (a random UUID) only travels in the
      // invite email, so opening that link is the proof; accept still requires the invited email.
      requireEmailVerificationOnInvitation: false,
      organizationHooks: {
        // Default "Main" location, trial subscription, company.created (src/modules/today).
        afterCreateOrganization: async ({ organization: org }) => {
          await onOrganizationCreated({ id: org.id, type: org.type as string | undefined });
        },
      },
      schema: {
        organization: {
          modelName: "companies",
          additionalFields: {
            // Never client input: vendor orgs are created by vendors.invite, plans by billing.
            type: { type: "string", required: false, defaultValue: "shop", input: false },
            plan: { type: "string", required: false, defaultValue: "trial", input: false },
            timezone: {
              type: "string",
              required: false,
              defaultValue: "America/Phoenix",
              input: true,
            },
            demo: { type: "boolean", required: false, defaultValue: false, input: false },
          },
        },
        member: {
          modelName: "members",
          additionalFields: {
            status: { type: "string", required: false, defaultValue: "active", input: false },
          },
        },
        invitation: { modelName: "invitations" },
      },
    }),
    invitePreviewPlugin,
  ],
});

export type Auth = typeof auth;
