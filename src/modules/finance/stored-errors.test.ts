import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "../../db/client";
import { jobs } from "../../db/schema";
import { runJobInline } from "../../lib/queues";
import { createCompany } from "../../test/fixtures";

/* B-343: a failed recompute stores the error head in jobs.error, never the `params:` tail. */

const recompute = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("./service", async (orig) => {
  const actual = await orig<typeof import("./service")>();
  return { ...actual, recomputeProfit: recompute.fn };
});

const { recomputeJob } = await import("./jobs");

describe("finance recompute job stores a scrubbed error (B-343)", () => {
  let companyId: string;
  beforeAll(async () => {
    companyId = (await createCompany()).id;
  });

  it("keeps the message head and drops the parameter values", async () => {
    const value = "Maria Perez 4410 Mesquite Lane";
    recompute.fn.mockRejectedValue(new Error(`Failed query: select 1\nparams: ${value}`));
    const [row] = await withSystem((tx) =>
      tx.insert(jobs).values({ companyId, kind: "profit_recompute", input: {} }).returning(),
    );
    const jobRowId = row?.id as string;
    await expect(runJobInline(recomputeJob, { companyId, jobRowId })).rejects.toThrow();
    const [after] = await withSystem((tx) => tx.select().from(jobs).where(eq(jobs.id, jobRowId)));
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/^Failed query/);
    expect(after?.error).not.toContain(value);
  });
});
