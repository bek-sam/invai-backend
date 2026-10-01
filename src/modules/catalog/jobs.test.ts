import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "../../db/client";
import { designFiles } from "../../db/schema";
import { ImagingError } from "../../integrations/imaging/client";
import { runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { createDesign } from "./service";

/*
 * B-209: the preview job calls `imaging.preview` once per placement and writes a deterministic
 * key, so running it twice (a retry, a duplicate enqueue) overwrites the same object instead of
 * leaving a second one behind.
 *
 * T-P2-2 (B-233): no DB transaction is open while `imaging.preview` runs, a transient failure
 * throws so the job retries and writes nothing, a permanent 4xx leaves no preview and no
 * placeholder, and a file replaced mid-render doesn't get the old render's key.
 */

const preview = vi.hoisted(() => ({
  fn: vi.fn(async (input: { out_key: string }) => {
    const { appPool, systemPool } = await import("../../db/client");
    preview.busyAtCall.push(
      appPool.totalCount - appPool.idleCount + systemPool.totalCount - systemPool.idleCount,
    );
    return { out_key: input.out_key, width_px: 512, height_px: 512 };
  }),
  busyAtCall: [] as number[],
}));

vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return { ...actual, imaging: { ...actual.imaging, preview: preview.fn } };
});

import { renderDesignPreviewsJob } from "./jobs";

beforeEach(() => {
  preview.busyAtCall.length = 0;
});

describe("catalog.renderDesignPreviews job", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const designer = await createUser(companyId, "designer");
    ctx = tenantContext(companyId, designer.id, "designer");
  });

  it("is idempotent: one preview per placement, same key on a rerun", async () => {
    const design = await withTenant(companyId, (tx) =>
      createDesign(tx, ctx, {
        code: "JOB1",
        name: "Job design",
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: `${companyId}/design/x.png`,
            widthIn: 10,
            heightIn: 11,
          },
        ],
        personalizationTemplateId: null,
      }),
    );
    preview.fn.mockClear();

    await runJobInline(renderDesignPreviewsJob, { companyId, designId: design.id });
    await runJobInline(renderDesignPreviewsJob, { companyId, designId: design.id });

    expect(preview.fn).toHaveBeenCalledTimes(2); // one placement, run twice
    const outKeys = preview.fn.mock.calls.map((c) => (c[0] as { out_key: string }).out_key);
    expect(outKeys[0]).toBe(outKeys[1]);
    expect(outKeys[0]).toMatch(new RegExp(`^${companyId}/preview/design/`));

    const [row] = await withTenant(companyId, (tx) =>
      tx
        .select({ previewKey: designFiles.previewKey })
        .from(designFiles)
        .where(eq(designFiles.designId, design.id)),
    );
    expect(row?.previewKey).toBe(outKeys[0]);
  });

  it("keeps company A's job from touching company B's rows", async () => {
    const companyB = (await createCompany()).id;
    const userB = await createUser(companyB, "designer");
    const ctxB = tenantContext(companyB, userB.id, "designer");
    const designB = await withTenant(companyB, (tx) =>
      createDesign(tx, ctxB, {
        code: "JOBB",
        name: "Company B design",
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: `${companyB}/design/x.png`,
            widthIn: 10,
            heightIn: 11,
          },
        ],
        personalizationTemplateId: null,
      }),
    );
    // Enqueued (or replayed) with the wrong companyId: withTenant(A, ...) can't see B's row.
    await expect(
      runJobInline(renderDesignPreviewsJob, { companyId, designId: designB.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  async function onePlacementDesign(code: string, fileKey?: string) {
    return withTenant(companyId, (tx) =>
      createDesign(tx, ctx, {
        code,
        name: `Design ${code}`,
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: fileKey ?? `${companyId}/design/${code}.png`,
            widthIn: 10,
            heightIn: 11,
          },
        ],
        personalizationTemplateId: null,
      }),
    );
  }

  it("calls imaging with no DB transaction open (T-P2-2 AC1)", async () => {
    const design = await onePlacementDesign("JOBTX");
    preview.busyAtCall.length = 0;

    await runJobInline(renderDesignPreviewsJob, { companyId, designId: design.id });

    expect(preview.busyAtCall).toEqual([0]);
  });

  // The render job's own contract (propagate, write nothing) with `imaging.preview` mocked
  // directly; it doesn't exercise the real HTTP client's failure handling — see
  // `jobs.imaging-down.test.ts` for that (round 2, reviewer r1 finding 1).
  it("a transient imaging failure throws so the job retries, and writes no preview (T-P2-2 AC2)", async () => {
    const design = await onePlacementDesign("JOBTRANS");
    preview.fn.mockRejectedValueOnce(new ImagingError("/preview", 0, "connection refused"));

    await expect(
      runJobInline(renderDesignPreviewsJob, { companyId, designId: design.id }),
    ).rejects.toBeInstanceOf(ImagingError);

    const [row] = await withTenant(companyId, (tx) =>
      tx
        .select({ previewKey: designFiles.previewKey })
        .from(designFiles)
        .where(eq(designFiles.designId, design.id)),
    );
    expect(row?.previewKey).toBeNull();
  });

  it("a permanent 4xx leaves no preview and no placeholder, and doesn't throw (T-P2-2 AC2)", async () => {
    const design = await onePlacementDesign("JOBPERM");
    preview.fn.mockRejectedValueOnce(new ImagingError("/preview", 422, "bad file"));

    await runJobInline(renderDesignPreviewsJob, { companyId, designId: design.id });

    const [row] = await withTenant(companyId, (tx) =>
      tx
        .select({ previewKey: designFiles.previewKey })
        .from(designFiles)
        .where(eq(designFiles.designId, design.id)),
    );
    expect(row?.previewKey).toBeNull();
  });

  it("a file replaced mid-render doesn't get the old render's key (T-P2-2 AC1)", async () => {
    const design = await onePlacementDesign("JOBRACE");
    const [file] = await withTenant(companyId, (tx) =>
      tx.select().from(designFiles).where(eq(designFiles.designId, design.id)),
    );
    if (!file) throw new Error("fixture file missing");
    preview.fn.mockImplementationOnce(async (input: { out_key: string }) => {
      // Simulate a replace landing while this call is in flight: same row id, new file_key.
      await withTenant(companyId, (tx) =>
        tx
          .update(designFiles)
          .set({ fileKey: `${companyId}/design/replaced.png` })
          .where(eq(designFiles.id, file.id)),
      );
      return { out_key: input.out_key, width_px: 512, height_px: 512 };
    });

    await runJobInline(renderDesignPreviewsJob, { companyId, designId: design.id });

    const [row] = await withTenant(companyId, (tx) =>
      tx
        .select({ previewKey: designFiles.previewKey, fileKey: designFiles.fileKey })
        .from(designFiles)
        .where(eq(designFiles.id, file.id)),
    );
    expect(row?.fileKey).toBe(`${companyId}/design/replaced.png`);
    expect(row?.previewKey).toBeNull(); // the stale render for the old file_key wasn't written
  });
});
