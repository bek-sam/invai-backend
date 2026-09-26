import { type Job, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "../db/client";
import { outboxEvents } from "../db/schema";
import { env } from "../env";
import { queues, redis } from "../lib/queues";
import { createCompany } from "../test/fixtures";
import { MAX_ATTEMPTS } from "../worker/outbox-relay";
import { app } from "./app";

/*
 * T-12-1 (wave 12 stub A): internal DLQ routes. Without the exact X-Internal-Token every route is
 * a plain 404; with it, failed jobs are listed and redriven, and parked outbox rows are reset.
 */

const TOKEN = "t121-internal-token-0123456789abcdef";
const mutableEnv = env as { INTERNAL_ADMIN_TOKEN?: string };
const saved = mutableEnv.INTERNAL_ADMIN_TOKEN;
const queue = queues.ship;
let companyId: string;
let calls = 0;
let worker: Worker;

const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set("X-Internal-Token", init.token ?? TOKEN);
  if (init.body) headers.set("Content-Type", "application/json");
  return app.request(path, { ...init, headers });
};

async function settle(job: Job, state: string) {
  const until = Date.now() + 10_000;
  while ((await job.getState()) !== state) {
    if (Date.now() > until) throw new Error(`job ${job.id} never reached ${state}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  mutableEnv.INTERNAL_ADMIN_TOKEN = TOKEN;
  companyId = (await createCompany()).id;
  await queue.obliterate({ force: true });
  // Fails the first run of each job, succeeds on the redrive.
  worker = new Worker(
    "ship",
    async (job) => {
      calls++;
      if (job.attemptsStarted <= 1 && !job.data.redriven) throw new Error("carrier down");
      return "ok";
    },
    { connection: redis },
  );
});
afterAll(async () => {
  mutableEnv.INTERNAL_ADMIN_TOKEN = saved;
  await worker.close();
  await queue.obliterate({ force: true });
});

describe("internal DLQ routes: access", () => {
  it("404s without the header, with a wrong token, and when the token is unset", async () => {
    const paths: [string, RequestInit][] = [
      ["/internal/dlq/failed?queue=ship", {}],
      [
        "/internal/dlq/redrive",
        { method: "POST", body: JSON.stringify({ queue: "ship", jobIds: ["x"] }) },
      ],
      ["/internal/dlq/redrive-outbox", { method: "POST", body: "{}" }],
    ];
    for (const [path, init] of paths) {
      for (const token of [null, "wrong", `${TOKEN}x`, ""]) {
        const res = await call(path, { ...init, token });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not found" });
      }
    }
    mutableEnv.INTERNAL_ADMIN_TOKEN = undefined;
    expect((await call("/internal/dlq/failed?queue=ship")).status).toBe(404);
    mutableEnv.INTERNAL_ADMIN_TOKEN = TOKEN;
  });
});

describe("internal DLQ routes: failed jobs and redrive", () => {
  it("lists a failed job and redrives it to completed; unknown ids come back in notFound", async () => {
    const job = await queue.add("test.t121.label", { companyId }, { attempts: 1 });
    await settle(job, "failed");

    const list = await call("/internal/dlq/failed?queue=ship");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      jobs: {
        id: string;
        name: string;
        companyId: string;
        attemptsMade: number;
        failedReason: string;
      }[];
      parkedOutbox: { count: number };
    };
    expect(body.jobs).toContainEqual(
      expect.objectContaining({
        id: job.id,
        name: "test.t121.label",
        companyId,
        attemptsMade: 1,
        failedReason: "carrier down",
      }),
    );
    expect(typeof body.parkedOutbox.count).toBe("number");

    await job.updateData({ companyId, redriven: true });
    const res = await call("/internal/dlq/redrive", {
      method: "POST",
      body: JSON.stringify({ queue: "ship", jobIds: [job.id, "no-such-job"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retried: [job.id], notFound: ["no-such-job"] });
    await settle(job, "completed");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("rejects a bad body or queue with 400", async () => {
    expect((await call("/internal/dlq/failed?queue=nope")).status).toBe(400);
    const res = await call("/internal/dlq/redrive", {
      method: "POST",
      body: JSON.stringify({ queue: "ship" }),
    });
    expect(res.status).toBe(400);
  });

  it("redrive-outbox resets parked rows", async () => {
    const [row] = await withSystem((tx) =>
      tx
        .insert(outboxEvents)
        .values({
          companyId,
          name: "test.t121.parked",
          payload: {},
          attempts: MAX_ATTEMPTS,
          lastError: "boom",
          dispatchedAt: new Date(),
        })
        .returning(),
    );
    const res = await call("/internal/dlq/redrive-outbox", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reset: number }).reset).toBeGreaterThanOrEqual(1);
    const [after] = await withSystem((tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.id, row?.id as string)),
    );
    expect(after?.dispatchedAt).toBeNull();
    await withSystem((tx) =>
      tx
        .update(outboxEvents)
        .set({ dispatchedAt: new Date() })
        .where(eq(outboxEvents.id, row?.id as string)),
    );
  });
});
