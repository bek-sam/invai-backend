import { eq } from "drizzle-orm";
import { withSystem } from "../../db/client";
import { companies, locations, subscriptions } from "../../db/schema";
import { errorData, logger } from "../../lib/log";
import { emit } from "../../lib/outbox";

const log = logger("org-hooks");

const TRIAL_DAYS = 14;

/**
 * Runs after Better Auth creates an organization (sign-up). Gives a shop a default "Main"
 * location and a trial subscription (never for a demo company), and emits `company.created`. Idempotent; never throws
 * (a failure here must not fail sign-up).
 */
export async function onOrganizationCreated(org: { id: string; type?: string | null }) {
  const type = org.type === "vendor" ? "vendor" : "shop";
  try {
    await withSystem(async (tx) => {
      const existing = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(eq(locations.companyId, org.id))
        .limit(1);
      if (!existing.length) {
        await tx.insert(locations).values({ companyId: org.id, name: "Main", isDefault: true });
      }
      // A demo company (sample data) has no plan: no trial to expire and lock it.
      const [company] = await tx
        .select({ demo: companies.demo })
        .from(companies)
        .where(eq(companies.id, org.id))
        .limit(1);
      if (type === "shop" && !company?.demo) {
        await tx
          .insert(subscriptions)
          .values({
            companyId: org.id,
            planKey: "trial",
            status: "trialing",
            trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
          })
          .onConflictDoNothing();
      }
      await emit(tx, org.id, "company.created", { orgId: org.id, type });
    }, org.id);
  } catch (err) {
    log.error("org setup failed", { orgId: org.id, ...errorData(err) });
  }
}
