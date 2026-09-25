import type { Me } from "@invai/contracts";

type OnboardingChecklist = NonNullable<Me["onboarding"]>;

import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { db, type Tx } from "../../db/client";
import type { CompanySettings } from "../../db/schema";
import {
  auditLog,
  blankVariants,
  channelConnections,
  companies,
  designs,
  locations,
  members,
  shippingSettings,
  skuRules,
  stations,
  subscriptions,
  vendorConnections,
} from "../../db/schema";
import { notFound } from "../../lib/errors";
import { pendingInvitations } from "./invites";

/*
 * The setup checklist on Today (Me.onboarding). Every step is read from the shop's own data, so
 * it ticks itself when the work is done anywhere in the app. `tx` is tenant-scoped (withTenant),
 * so the tenant-table counts are already per company; `companies`/`members` carry no RLS and are
 * filtered by id explicitly (this module may read them, see service.ts).
 *
 * Step definitions (wave 5 contract, "Contract stubs (exact)" §2):
 *   shipFromAddress  a location has an address, or shipping settings have a from address
 *   carrier          shipping settings exist with at least one allowed carrier
 *   tabletPaired     a station has had a station token issued
 *   designsUploaded  at least one design
 *   costsSet         cost settings were saved by the shop at least once (audit
 *                    `cost_settings.update`); the row itself is created with defaults on first
 *                    read or profit run, so "exists" alone would tick it for everyone
 *   planChosen       a paid plan (not trialing / trial_expired), or a demo company (no billing)
 */

const exists = (rows: { n: number }[]) => (rows[0]?.n ?? 0) > 0;

export async function onboardingChecklist(tx: Tx, companyId: string): Promise<OnboardingChecklist> {
  const [company] = await db
    .select({ demo: companies.demo, settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) throw notFound("company", companyId);
  const settings = (company.settings ?? {}) as CompanySettings;
  const [memberCount] = await db
    .select({ n: count() })
    .from(members)
    .where(eq(members.organizationId, companyId));

  const [ship] = await tx
    .select({
      from: shippingSettings.fromAddress,
      carriers: sql<number>`coalesce(cardinality(${shippingSettings.allowedCarriers}), 0)`.mapWith(
        Number,
      ),
    })
    .from(shippingSettings)
    .limit(1);
  const [sub] = await tx
    .select({ status: subscriptions.status, stripe: subscriptions.stripeSubscriptionId })
    .from(subscriptions)
    .limit(1);

  return {
    channelConnected: exists(await tx.select({ n: count() }).from(channelConnections)),
    blanksImported: exists(await tx.select({ n: count() }).from(blankVariants)),
    skusMapped: exists(await tx.select({ n: count() }).from(skuRules)),
    vendorAdded: exists(await tx.select({ n: count() }).from(vendorConnections)),
    staffInvited: (memberCount?.n ?? 0) > 1 || (await pendingInvitations(tx, companyId)).length > 0,
    shipFromAddress:
      !!ship?.from ||
      exists(await tx.select({ n: count() }).from(locations).where(isNotNull(locations.address))),
    carrier: (ship?.carriers ?? 0) > 0,
    tabletPaired: exists(
      await tx.select({ n: count() }).from(stations).where(isNotNull(stations.tokenIssuedAt)),
    ),
    designsUploaded: exists(await tx.select({ n: count() }).from(designs)),
    costsSet: exists(
      await tx
        .select({ n: count() })
        .from(auditLog)
        .where(eq(auditLog.action, "cost_settings.update")),
    ),
    planChosen:
      company.demo ||
      (!!sub && sub.status !== "trialing" && sub.status !== "trial_expired") ||
      !!sub?.stripe,
    dismissed: !!settings.onboardingDismissedAt,
    dismissedAt: settings.onboardingDismissedAt ?? null,
  };
}

/**
 * today.dismissChecklist: hide (or bring back) the checklist for everyone in this company.
 * Stored as one key in `companies.settings`, merged so other settings keys are untouched.
 */
export async function setChecklistDismissed(
  tx: Tx,
  companyId: string,
  dismissed: boolean,
): Promise<OnboardingChecklist> {
  const patch = dismissed
    ? sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('onboardingDismissedAt', ${new Date().toISOString()}::text)`
    : sql`coalesce(${companies.settings}, '{}'::jsonb) - 'onboardingDismissedAt'`;
  const updated = await db
    .update(companies)
    .set({ settings: patch })
    .where(and(eq(companies.id, companyId), eq(companies.type, "shop")))
    .returning({ id: companies.id });
  if (!updated.length) throw notFound("company", companyId);
  return onboardingChecklist(tx, companyId);
}
