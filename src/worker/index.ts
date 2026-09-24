import { Worker } from "bullmq";
import { QUEUE_NAMES, redis } from "../lib/queues";

const CONCURRENCY: Record<(typeof QUEUE_NAMES)[number], number> = {
  sync: 10,
  render: 2,
  ship: 5,
  ai: 4,
  reports: 1,
};

for (const name of QUEUE_NAMES) {
  const worker = new Worker(
    name,
    async (job) => {
      // TODO: dispatch job.name to the owning module
      console.log(`[${name}] ${job.name} ${job.id}`);
    },
    { connection: redis, concurrency: CONCURRENCY[name] },
  );
  worker.on("failed", (job, err) => console.error(`[${name}] ${job?.id} failed`, err));
}

console.log("invai worker started");
