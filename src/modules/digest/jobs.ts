import { sql } from "drizzle-orm";
import { z } from "zod";
import { withSystem, withTenant } from "../../db/client";
import { env } from "../../env";
import { registerLinkHandler } from "../../lib/links";
import { errorData, logger } from "../../lib/log";
import { defineJob, onEvent, queues } from "../../lib/queues";
import { realCompanySql } from "../tenancy/demo-flag";
import { buildDigest } from "./build";
import { DIGEST_CONFIG as C } from "./config";
import { deliverDigest } from "./deliver";
import { clickTarget } from "./service";
import { addDays, isoWeekKey, mondayOf } from "./week";

/*
 * Digest jobs (spec pipeline 1–3, 12):
 * - `digest.sweep` (hourly): finds shops whose local time is at or after their send slot and have
 *   no finished digest for last week, and builds them. Local time and DST come from Postgres
 *   (`AT TIME ZONE`). Sample workspaces, vendor orgs, soft-deleted and disabled shops are skipped.
 * - `digest.build`: one shop, one week (also the manual/forced path). Idempotent on the week key.
 * - `digest.deliver`: on `digest.ready`, emails opted-in members once each.
 * - `digest.purge`: nightly retention.
 */

const log = logger("digest.jobs");

export type DueShop = { companyId: string; weekKey: string };

/**
 * Shops due at `at`, one page (keyset on company id). Cross-tenant read of ids only: the sweep
 * has no tenant yet (withSystem, the documented exception for cross-tenant sweeps); each build
 * then runs under `withTenant`.
 */
export async function dueShops(at: Date, after: string | null, limit: number): Promise<DueShop[]> {
  const rows = await withSystem((tx) =>
    tx.execute<{ id: string; local_ymd: string }>(sql`
      with shops as (
        select companies.id,
               (${at.toISOString()}::timestamptz at time zone companies.timezone) as local_now,
               coalesce(s.day, 'mon') as day,
               coalesce(s.hour, ${C.schedule.defaultHour}) as hour
        from companies
        left join digest_settings s on s.company_id = companies.id
        where companies.type = 'shop'
          and companies.deleted_at is null
          and coalesce(s.enabled, true)
          and ${realCompanySql()}
          and (${after}::uuid is null or companies.id > ${after}::uuid)
      )
      select id, to_char(local_now, 'YYYY-MM-DD') as local_ymd
      from shops
      where local_now >= date_trunc('week', local_now)
            + (array_position(array['mon','tue','wed','thu','fri','sat','sun'], day) - 1) * interval '1 day'
            + hour * interval '1 hour'
        and not exists (
          select 1 from digests d
          where d.company_id = shops.id
            and d.week_start = (date_trunc('week', local_now) - interval '7 days')::date
            and d.status in ('ready', 'skipped_quiet')
        )
      order by id
      limit ${limit}`),
  );
  return rows.rows.map((r) => ({
    companyId: r.id,
    weekKey: isoWeekKey(addDays(mondayOf(r.local_ymd), -7)),
  }));
}

/** One sweep: every due shop is built in turn; one shop's failure never stops the others. */
export async function sweep(at: Date = new Date()) {
  if (!env.DIGEST_ENABLED) return { built: 0, failed: 0, disabled: true };
  let after: string | null = null;
  let built = 0;
  let failed = 0;
  for (;;) {
    const page = await dueShops(at, after, C.schedule.sweepPageSize);
    for (const s of page) {
      try {
        await buildDigest(s.companyId, s.weekKey, at);
        built++;
      } catch (err) {
        failed++;
        log.warn("digest build failed in sweep; next sweep retries", {
          companyId: s.companyId,
          weekKey: s.weekKey,
          ...errorData(err),
        });
      }
    }
    if (page.length < C.schedule.sweepPageSize) break;
    after = page[page.length - 1]?.companyId ?? null;
  }
  if (built || failed) log.info("digest sweep", { built, failed });
  return { built, failed, disabled: false };
}

export const sweepJob = defineJob({
  queue: "reports",
  name: "digest.sweep",
  input: z.object({}),
  handler: async () => sweep(new Date()),
});

export const buildJob = defineJob({
  queue: "reports",
  name: "digest.build",
  input: z.object({ companyId: z.uuid(), weekKey: z.string().regex(/^\d{4}-W\d{2}$/) }),
  jobId: (i) => `digest-build-${i.companyId}-${i.weekKey}`,
  options: { attempts: 3, backoff: { type: "exponential", delay: 60_000, jitter: 0.5 } },
  handler: async ({ companyId, weekKey }) => buildDigest(companyId, weekKey, new Date()),
});

export const deliverJob = defineJob({
  queue: "reports",
  name: "digest.deliver",
  input: z.object({ companyId: z.uuid(), digestId: z.uuid() }),
  jobId: (i) => `digest-deliver-${i.digestId}`,
  options: { attempts: 5, backoff: { type: "exponential", delay: 30_000, jitter: 0.5 } },
  handler: async ({ companyId, digestId }) => {
    const out = await deliverDigest(companyId, digestId, new Date());
    // Built before 07:00 on the send day: try again at the top of the next hour.
    if (out.waiting)
      await deliverJob.enqueue(
        { companyId, digestId },
        {
          delay: 3_600_000 - (Date.now() % 3_600_000),
          jobId: `digest-deliver-${digestId}-${Math.floor(Date.now() / 3_600_000)}`,
        },
      );
    return out;
  },
});
onEvent("digest.ready", deliverJob, (e) => ({
  companyId: e.companyId,
  digestId: String(e.payload.digestId),
}));

/** Nightly: digests past retention (cascade removes insights, votes, clicks, views, deliveries). */
export const purgeJob = defineJob({
  queue: "reports",
  name: "digest.purge",
  input: z.object({}),
  handler: async () => {
    // Cross-tenant retention delete by age only (withSystem: a nightly sweep with no tenant).
    const res = await withSystem((tx) =>
      tx.execute(
        sql`delete from digests where week_start < (now() - make_interval(weeks => ${C.retentionWeeks}))::date`,
      ),
    );
    return { deleted: res.rowCount ?? 0 };
  },
});

/** Email click links (T-19-4 `/l/:token`, `ref = digestId:insightId`): record, then open the action. */
registerLinkHandler("click", async ({ companyId, userId, ref }) => {
  const [digestId, insightId] = ref.split(":");
  const uuid = z.uuid();
  if (!uuid.safeParse(digestId).success || !uuid.safeParse(insightId).success) return null;
  const path = await withTenant(companyId, (tx) =>
    clickTarget(
      tx,
      { companyId, userId },
      { digestId: digestId as string, insightId: insightId as string },
    ),
  ).catch(() => null);
  return path ? { path } : null;
});

/** Idempotent: registers the hourly sweep and the nightly purge (API and worker). */
export async function scheduleDigestJobs() {
  await queues.reports.upsertJobScheduler(
    "digest-sweep",
    { pattern: "5 * * * *", tz: "UTC" },
    { name: sweepJob.name, data: {} },
  );
  await queues.reports.upsertJobScheduler(
    "digest-purge",
    { pattern: "40 4 * * *", tz: "UTC" },
    { name: purgeJob.name, data: {} },
  );
}

if (!env.isTest) {
  scheduleDigestJobs().catch((err) =>
    log.warn("could not register the digest schedulers", errorData(err)),
  );
}
