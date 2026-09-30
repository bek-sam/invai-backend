import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { systemContext } from "../../api/context";
import { withSystem, withTenant } from "../../db/client";
import { companies } from "../../db/schema";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { defineJob, queues } from "../../lib/queues";
import { DIGEST_CONFIG as C } from "../digest/config";
import { realCompanySql } from "../tenancy/demo-flag";
import { buildTodayActions } from "./actions";
import { generateAlerts } from "./service";

const log = logger("today.jobs");

export const ALERT_SWEEP_EVERY_MS = 5 * 60_000;

/** One company's alert sweep; the id is bucketed per 5 minutes so a sweep never runs twice. */
export const generateAlertsJob = defineJob({
  queue: "reports",
  name: "today.generateAlerts",
  input: z.object({ companyId: z.uuid(), bucket: z.number().int() }),
  jobId: (i) => `alerts-${i.companyId}-${i.bucket}`,
  handler: async ({ companyId }) =>
    withTenant(companyId, (tx) => generateAlerts(tx, systemContext(companyId))),
});

/** Fan-out over every shop (cross-tenant: owner connection, ids only). */
export const alertsSweepJob = defineJob({
  queue: "reports",
  name: "today.alertsSweep",
  input: z.object({}).passthrough(),
  handler: async () => {
    const shops = await withSystem((tx) =>
      tx.select({ id: companies.id }).from(companies).where(eq(companies.type, "shop")),
    );
    const bucket = Math.floor(Date.now() / ALERT_SWEEP_EVERY_MS);
    for (const s of shops) await generateAlertsJob.enqueue({ companyId: s.id, bucket });
    return { shops: shops.length };
  },
});

/** Idempotent: registers the 5-minute alert scheduler (safe from API and worker). */
export async function scheduleAlertJobs() {
  await queues.reports.upsertJobScheduler(
    "alerts-sweep",
    { every: ALERT_SWEEP_EVERY_MS },
    { name: alertsSweepJob.name, data: {} },
  );
}

if (!env.isTest) {
  scheduleAlertJobs().catch((err) =>
    log.warn("could not register the alert scheduler", errorData(err)),
  );
}

/* ------------------------------ Today's action panel (T-A9) ------------------------------ */

/**
 * Builds one shop's action set for one local day. The jobId is the idempotency key's first
 * filter; the `(company_id, date)` set row is the guarantee (`buildTodayActions`).
 */
export const buildTodayActionsJob = defineJob({
  queue: "reports",
  name: "today.buildActions",
  input: z.object({ companyId: z.uuid(), date: z.iso.date() }),
  jobId: (i) => `today-actions-${i.companyId}-${i.date}`,
  options: { attempts: 3, backoff: { type: "exponential", delay: 60_000, jitter: 0.5 } },
  handler: async ({ companyId, date }) => buildTodayActions(companyId, date),
});

/**
 * Shops whose local today has no action set, one page (keyset on company id). Cross-tenant read
 * of ids only (withSystem: the sweep has no tenant yet); each build runs under `withTenant`.
 */
export async function shopsMissingToday(
  at: Date,
  after: string | null,
  limit: number,
): Promise<{ companyId: string; date: string }[]> {
  const res = await withSystem((tx) =>
    tx.execute<{ id: string; local_ymd: string }>(sql`
      with shops as (
        select companies.id,
               (${at.toISOString()}::timestamptz at time zone companies.timezone)::date as local_ymd
        from companies
        where companies.type = 'shop'
          and companies.deleted_at is null
          and ${realCompanySql()}
          and (${after}::uuid is null or companies.id > ${after}::uuid)
      )
      select id, to_char(local_ymd, 'YYYY-MM-DD') as local_ymd
      from shops
      where not exists (
        select 1 from today_action_sets s where s.company_id = shops.id and s.date = shops.local_ymd
      )
      order by id
      limit ${limit}`),
  );
  return res.rows.map((r) => ({ companyId: r.id, date: r.local_ymd }));
}

/** Hourly: enqueue a build for every shop whose local day has no set yet. */
export async function sweepTodayActions(at: Date = new Date()) {
  let after: string | null = null;
  let enqueued = 0;
  for (;;) {
    const page = await shopsMissingToday(at, after, TODAY_SWEEP_PAGE);
    for (const s of page) {
      await buildTodayActionsJob.enqueue(s);
      enqueued++;
    }
    if (page.length < TODAY_SWEEP_PAGE) break;
    after = page[page.length - 1]?.companyId ?? null;
  }
  if (enqueued) log.info("today actions sweep", { enqueued });
  return { enqueued };
}

const TODAY_SWEEP_PAGE = 500;

export const todayActionsSweepJob = defineJob({
  queue: "reports",
  name: "today.actionsSweep",
  input: z.object({}).passthrough(),
  handler: async () => sweepTodayActions(new Date()),
});

/** Nightly retention: sets older than 90 days (cascade removes their actions and clicks). */
export async function purgeTodayActions(at: Date = new Date()) {
  // Cross-tenant delete by age only (withSystem: a nightly sweep with no tenant).
  const res = await withSystem((tx) =>
    tx.execute(
      sql`delete from today_action_sets
          where date < (${at.toISOString()}::timestamptz - make_interval(days => ${C.today.retentionDays}))::date`,
    ),
  );
  return { deleted: res.rowCount ?? 0 };
}

export const purgeTodayActionsJob = defineJob({
  queue: "reports",
  name: "today.actionsPurge",
  input: z.object({}).passthrough(),
  handler: async () => purgeTodayActions(new Date()),
});

/** Idempotent: registers the hourly sweep and the nightly purge (API and worker). */
export async function scheduleTodayActionJobs() {
  await queues.reports.upsertJobScheduler(
    "today-actions-sweep",
    { pattern: "15 * * * *", tz: "UTC" },
    { name: todayActionsSweepJob.name, data: {} },
  );
  await queues.reports.upsertJobScheduler(
    "today-actions-purge",
    { pattern: "50 4 * * *", tz: "UTC" },
    { name: purgeTodayActionsJob.name, data: {} },
  );
}

if (!env.isTest) {
  scheduleTodayActionJobs().catch((err) =>
    log.warn("could not register the today action schedulers", errorData(err)),
  );
}
