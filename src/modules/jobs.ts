/**
 * Registers every module's jobs with the queue registry (src/lib/queues.ts). The worker and
 * the API both import this file: the worker to run handlers, the API so `job.enqueue()` and
 * outbox subscriptions are known everywhere. Add your module's `jobs.ts` here.
 */
import "./catalog/jobs";
import "./orders/jobs";
import "./channels/jobs";
import "./personalization/jobs";
import "./production/jobs";
import "./vendors/jobs";
import "./inventory/jobs";
import "./shipping/jobs";
import "./finance/jobs";
import "./ai/jobs";
import "./billing/jobs";
import "./tenancy/jobs";
import "./today/jobs";
