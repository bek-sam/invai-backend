import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "../../db/client";
import { designFiles } from "../../db/schema";
import { runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { createDesign } from "./service";

/*
 * B-209: the preview job calls `imaging.preview` once per placement and writes a deterministic
 * key, so running it twice (a retry, a duplicate enqueue) overwrites the same object instead of
 * leaving a second one behind.
 */

const preview = vi.hoisted(() => ({
  fn: vi.fn(async (input: { out_key: string }) => ({
    out_key: input.out_key,
    width_px: 512,
    height_px: 512,
  })),
}));

vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return { ...actual, imaging: { ...actual.imaging, preview: preview.fn } };
});

import { renderDesignPreviewsJob } from "./jobs";

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
});
