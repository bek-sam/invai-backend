import { z } from "zod";
import { logger } from "../../lib/log";
import { defineJob } from "../../lib/queues";
import { runGenerationJob, setGenerationEnqueuer } from "./service";

const log = logger("ai.jobs");

/** Writes the listing drafts of one `listing_drafts` job (ai queue, metered per company). */
export const generateListingDrafts = defineJob({
  queue: "ai",
  name: "ai.generateListingDrafts",
  input: z.object({
    companyId: z.uuid(),
    jobId: z.uuid(),
    draftIds: z.array(z.uuid()).min(1),
    userId: z.uuid().nullable(),
  }),
  jobId: (i) => `listing-drafts-${i.jobId}`,
  options: { attempts: 2 },
  handler: (input) => runGenerationJob(input),
});

setGenerationEnqueuer(async (input) => {
  try {
    await generateListingDrafts.enqueue(input);
  } catch (err) {
    // Redis down: generate in-process so the drafts don't sit in `generating` forever.
    log.warn("enqueue failed, generating inline", { error: (err as Error).message });
    void runGenerationJob(input).catch((e) =>
      log.error("inline generation failed", { error: (e as Error).message }),
    );
  }
});
