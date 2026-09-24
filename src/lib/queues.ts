import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../env";

/** BullMQ needs maxRetriesPerRequest: null. Redis must run with maxmemory-policy noeviction. */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const QUEUE_NAMES = ["sync", "render", "ship", "ai", "reports"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const queues = Object.fromEntries(
  QUEUE_NAMES.map((name) => [name, new Queue(name, { connection: redis })]),
) as Record<QueueName, Queue>;
