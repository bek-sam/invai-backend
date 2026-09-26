/*
 * T-12-3 (B-20) load-test evidence: two tenants share one BullMQ queue (modeled on the real
 * "sync" queue, concurrency 10, where `channels.importCsv` -- bulk, chunked, `priority: 10` --
 * and `channels.sync` -- one connection's order sync, interactive, no explicit priority -- both
 * run). Tenant A runs a 3,000-row CSV import (chunked 100 rows/job, matching
 * `src/modules/channels/sync.ts`'s real chunk size, so 30 jobs); tenant B runs 5 single order
 * syncs (the card's own AC4 ratio). This measures tenant B's latency BEFORE (no fairness wrapper,
 * no priority -- every job plain FIFO) and AFTER (the T-12-3 semaphore + bulk priority) so the
 * card's "before and after the semaphore" evidence is a real number, not a unit-test assertion.
 *
 * Run: REDIS_URL=redis://localhost:6379/14 pnpm tsx scripts/t12-3-fairness-loadtest.ts
 */
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { BULK_PRIORITY, companyIdFromData, withFairness } from "../src/lib/fairness";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/14";
// The real "sync" queue name (src/lib/queues.ts), not a made-up one: `capForQueue` (fairness.ts)
// scales the tenant cap off `QUEUE_CONCURRENCY[queue]`, so this must resolve to the same entry
// production jobs use. Isolated on REDIS_URL's own DB (14 for this card) and obliterated before
// and after each run, so it never touches a real queue's data.
const QUEUE = "sync";
const CONCURRENCY = 10; // QUEUE_CONCURRENCY.sync
const JOB_MS = 150; // fake per-job work: a chunk of ~100 CSV rows (DB writes) or one connection's sync

const TENANT_A = "tenant-a-bulk-csv-import";
const TENANT_B = "tenant-b-single-order-sync";
const A_CHUNKS = 30; // 3,000 rows / 100 rows per chunk, same chunking as channels/sync.ts
const B_JOBS = 5; // matches the card's own AC4 scenario (200 bulk vs 5 interactive)

async function settle(job: Job, ms = 30_000): Promise<number> {
  const start = Date.now();
  const until = start + ms;
  for (;;) {
    const state = await job.getState();
    if (state === "completed") return Date.now() - start;
    if (state === "failed") throw new Error(`job ${job.id} failed`);
    if (Date.now() > until) throw new Error(`job ${job.id} did not finish within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

async function runScenario(label: string, fair: boolean): Promise<void> {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  const queue = new Queue(QUEUE, { connection: redis });
  await queue.obliterate({ force: true });

  const plainHandler = async () => {
    await new Promise((r) => setTimeout(r, JOB_MS));
  };
  const processor = fair ? withFairness(companyIdFromData, plainHandler) : plainHandler;
  const worker = new Worker(QUEUE, processor, { connection: redis, concurrency: CONCURRENCY });

  // Tenant A's bulk import lands first, all 30 chunks at once (a real import enqueues its next
  // chunk as soon as the previous one commits -- this is the worst case, all already queued).
  for (let i = 0; i < A_CHUNKS; i++) {
    await queue.add(
      "bulk.csvImportChunk",
      { companyId: TENANT_A, i },
      fair ? { priority: BULK_PRIORITY } : {},
    );
  }

  // Tenant B's order syncs arrive right after, unrelated to tenant A.
  const bJobs: Job[] = [];
  for (let i = 0; i < B_JOBS; i++) {
    bJobs.push(await queue.add("interactive.orderSync", { companyId: TENANT_B, i }));
  }

  const wallStart = Date.now();
  const latencies = await Promise.all(bJobs.map((j) => settle(j)));
  const wallElapsed = Date.now() - wallStart;

  const sorted = [...latencies].sort((x, y) => x - y);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1] ?? 0;

  console.log(`\n${label}`);
  console.log(`  tenant B (${B_JOBS} jobs) latency: p50=${p50}ms p95=${p95}ms max=${max}ms`);
  console.log(`  tenant B fully drained after: ${wallElapsed}ms wall clock`);

  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  redis.disconnect();
}

async function main() {
  await runScenario("BEFORE (no semaphore, no bulk priority -- plain FIFO)", false);
  await runScenario("AFTER (T-12-3 semaphore + bulk priority)", true);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
