import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, ownerAc } from "better-auth/plugins/organization/access";
import { eq } from "drizzle-orm";
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

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { users, sessions, accounts, verifications, companies, members, invitations },
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.WEB_ORIGIN, env.FLOOR_ORIGIN],
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  user: { modelName: "users" },
  session: {
    modelName: "sessions",
    expiresIn: 60 * 60 * 24 * 14,
    updateAge: 60 * 60 * 24,
  },
  account: { modelName: "accounts" },
  verification: { modelName: "verifications" },
  advanced: { database: { generateId: "uuid" } },
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
      schema: {
        organization: {
          modelName: "companies",
          additionalFields: {
            type: { type: "string", required: false, defaultValue: "shop", input: true },
            plan: { type: "string", required: false, defaultValue: "trial", input: true },
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
  ],
});

export type Auth = typeof auth;
