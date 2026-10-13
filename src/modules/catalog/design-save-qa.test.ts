import { and, desc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "../../db/client";
import { designFiles, outboxEvents } from "../../db/schema";
import { headObject, putObject } from "../../lib/s3";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { classify } from "../production/sheets";
import { setQaCooldown } from "./qa-turn";

/*
 * T-44-1 (B-393): a save that doesn't change a placement's file or print size keeps its QA
 * result, preview and row id. Imaging is stubbed; everything else runs against invai_test.
 */
const img = vi.hoisted(() => ({
  qaCheck: vi.fn(),
  cleanAlpha: vi.fn(),
  isUp: vi.fn(async () => true),
  preview: vi.fn(async (input: { out_key: string }) => ({
    out_key: input.out_key,
    width_px: 512,
    height_px: 512,
  })),
}));
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return { ...actual, imaging: { ...actual.imaging, ...img } };
});

import * as svc from "./service";

const result = (issues: unknown[]) => ({
  width_px: 3000,
  height_px: 2400,
  has_alpha: true,
  soft_alpha_ratio: 0,
  effective_dpi: 240,
  issues,
});
const issue = (severity: "warn" | "error", code: string) => ({
  code,
  severity,
  message: `${code} ${severity}`,
});

describe("design save keeps QA state (T-44-1)", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let n = 0;

  beforeAll(async () => {
    setQaCooldown(0);
    companyId = (await createCompany()).id;
    const u = await createUser(companyId, "designer", { name: "Dana Designer" });
    ctx = tenantContext(companyId, u.id, "designer");
  });
  beforeEach(() => {
    img.qaCheck.mockReset();
    img.cleanAlpha.mockReset();
  });

  const placement = (p: "front" | "back", tag: string, w = 10, h = 10) => ({
    placement: p,
    fileKey: `${companyId}/design/${tag}.png`,
    widthIn: w,
    heightIn: h,
  });

  async function make(placements: ReturnType<typeof placement>[]) {
    n++;
    const d = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, ctx, {
        code: `SV${n}-${Math.random().toString(36).slice(2, 6)}`,
        name: `Save ${n}`,
        tags: [],
        placements,
        personalizationTemplateId: null,
      }),
    );
    return d;
  }
  const rows = (designId: string) =>
    withTenant(companyId, (tx) =>
      tx.select().from(designFiles).where(eq(designFiles.designId, designId)),
    );
  const save = (id: string, patch: Omit<svc.DesignUpdateInput, "id">) =>
    withTenant(companyId, (tx) => svc.updateDesign(tx, ctx, { id, ...patch }));
  const lastEvent = async (designId: string) =>
    withTenant(companyId, async (tx) => {
      const [e] = await tx
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.name, "design.updated")))
        .orderBy(desc(outboxEvents.createdAt));
      expect(e?.payload.designId).toBe(designId);
      return e?.payload.qaRequested;
    });
  const checkAll = async (designId: string, issues: unknown[]) => {
    img.qaCheck.mockResolvedValue(result(issues));
    await withTenant(companyId, (tx) => svc.runDesignQa(tx, ctx, designId));
  };
  const renderPreviews = (designId: string) => svc.renderDesignPreviews(companyId, ctx, designId);

  it("AC1: failed / warn / passed placements keep their whole QA result on a metadata-only save; the sheet still skips the failed one", async () => {
    const same = [placement("front", "ac1f"), placement("back", "ac1b")];
    const d = await make(same);
    img.qaCheck.mockImplementation(async (i: { file_key: string }) =>
      result(
        i.file_key.endsWith("ac1f.png")
          ? [issue("error", "thin_line")]
          : [issue("warn", "non_srgb")],
      ),
    );
    await withTenant(companyId, (tx) => svc.runDesignQa(tx, ctx, d.id));
    const before = await rows(d.id);
    expect(before.find((r) => r.placement === "front")?.qaStatus).toBe("failed");
    expect(before.find((r) => r.placement === "back")?.qaStatus).toBe("warn");

    await save(d.id, { name: "Renamed", tags: ["x"], placements: same });

    const after = await rows(d.id);
    for (const b of before) {
      const a = after.find((r) => r.placement === b.placement);
      expect(a).toMatchObject({
        id: b.id,
        qaStatus: b.qaStatus,
        qaIssues: b.qaIssues,
        effectiveDpi: 240,
        widthPx: 3000,
        heightPx: 2400,
      });
      expect(a?.qaCheckedAt?.getTime()).toBe(b.qaCheckedAt?.getTime());
    }
    const failed = after.find((r) => r.placement === "front");
    const view = {
      item: {
        state: "ready",
        transferId: null,
        blankVariantId: "b",
        printWidthIn: null,
        printHeightIn: null,
        isReprint: false,
      },
      design: { id: d.id, name: "d", code: "c", templateId: null },
    } as never;
    expect(
      classify(view, failed ?? null, { maxWidthIn: 22, maxLengthIn: 60 } as never).reason,
    ).toBe("artwork_qa_failed");
  });

  it("AC1: an accepted warning survives (acceptedBy / acceptedAt)", async () => {
    const same = [placement("front", "ac1a")];
    const d = await make(same);
    await checkAll(d.id, [issue("warn", "white_box")]);
    await withTenant(companyId, (tx) =>
      svc.acceptQaWarning(tx, ctx, { id: d.id, placement: "front", code: "white_box" }),
    );
    const [before] = await rows(d.id);
    expect(before?.qaIssues[0]).toHaveProperty("acceptedAt");
    await save(d.id, { name: "Again", placements: same });
    const [r] = await rows(d.id);
    expect(r?.qaIssues[0]).toMatchObject({ code: "white_box" });
    expect(r?.qaIssues[0]).toHaveProperty("acceptedAt");
    expect(r?.qaIssues).toEqual(before?.qaIssues);
  });

  it("AC2: a changed file key or print size goes to pending with no issues, and QA is requested", async () => {
    const f = placement("front", "ac2f");
    const b = placement("back", "ac2b");
    const d = await make([f, b]);
    await checkAll(d.id, [issue("error", "thin_line")]);
    await save(d.id, {
      placements: [
        { ...f, widthIn: 11 },
        { ...b, fileKey: `${companyId}/design/ac2b2.png` },
      ],
    });
    for (const r of await rows(d.id)) {
      expect(r).toMatchObject({
        qaStatus: "pending",
        qaIssues: [],
        qaCheckedAt: null,
        effectiveDpi: null,
        widthPx: null,
        previewKey: null,
      });
    }
    expect(await lastEvent(d.id)).toBe(true);
  });

  it("AC3: adding a placement leaves only the new one pending", async () => {
    const f = placement("front", "ac3f");
    const d = await make([f]);
    await checkAll(d.id, [issue("error", "thin_line")]);
    await renderPreviews(d.id);
    await save(d.id, { placements: [f, placement("back", "ac3b")] });
    const after = await rows(d.id);
    expect(after.find((r) => r.placement === "front")?.qaStatus).toBe("failed");
    expect(after.find((r) => r.placement === "back")?.qaStatus).toBe("pending");
    expect(await lastEvent(d.id)).toBe(true);
  });

  it("A1: qaRequested is false for a fully checked, fully previewed metadata-only save; true for a carried pending row or a missing preview", async () => {
    const same = [placement("front", "a1f")];
    const d = await make(same);
    await checkAll(d.id, [issue("warn", "non_srgb")]);
    await renderPreviews(d.id);
    await save(d.id, { name: "Quiet", placements: same });
    expect(await lastEvent(d.id)).toBe(false);

    // No placements in the input at all: nothing to re-check.
    await save(d.id, { name: "Quieter" });
    expect(await lastEvent(d.id)).toBe(false);

    // A carried row still pending (QA never ran) asks for QA.
    const p = placement("front", "a1p");
    const d2 = await make([p]);
    await renderPreviews(d2.id);
    await save(d2.id, { name: "Pending", placements: [p] });
    expect(await lastEvent(d2.id)).toBe(true);

    // A carried row that is checked but has no preview asks for previews.
    const q = placement("front", "a1q");
    const d3 = await make([q]);
    await checkAll(d3.id, []);
    await save(d3.id, { name: "NoPreview", placements: [q] });
    expect(await lastEvent(d3.id)).toBe(true);
  });

  it("A19: carried previews survive the save and their objects are not deleted", async () => {
    const same = [placement("front", "a19")];
    const d = await make(same);
    await checkAll(d.id, []);
    const rendered = await renderPreviews(d.id);
    const key = rendered.placements[0]?.previewKey;
    if (!key) throw new Error("fixture preview missing");
    await putObject(key, "png", "image/png");
    const u = await save(d.id, { name: "Keep", placements: same });
    expect(u.placements[0]?.previewKey).toBe(key);
    expect((await headObject(key)).exists).toBe(true);
  });

  it("A2: an unchanged row keeps its id; after the preview job its key is designPreviewKey(company, id)", async () => {
    const a = placement("front", "a2a");
    const b = placement("back", "a2b");
    const d = await make([a, b]);
    await checkAll(d.id, []);
    await renderPreviews(d.id);
    const before = await rows(d.id);
    const aId = before.find((r) => r.placement === "front")?.id as string;
    await save(d.id, { placements: [a, { ...b, fileKey: `${companyId}/design/a2b2.png` }] });
    expect(await lastEvent(d.id)).toBe(true);
    await renderPreviews(d.id);
    const after = await rows(d.id);
    const aa = after.find((r) => r.placement === "front");
    expect(aa?.id).toBe(aId);
    expect(aa?.previewKey).toBe(svc.designPreviewKey(companyId, aId));
    expect(after.find((r) => r.placement === "back")?.id).not.toBe(
      before.find((r) => r.placement === "back")?.id,
    );
  });

  it("run twice: saving the same input twice leaves the same rows", async () => {
    const same = [placement("front", "twice")];
    const d = await make(same);
    await checkAll(d.id, [issue("error", "thin_line")]);
    await save(d.id, { placements: same });
    const one = await rows(d.id);
    await save(d.id, { placements: same });
    const strip = (rs: Awaited<ReturnType<typeof rows>>) =>
      rs.map(({ createdAt: _c, updatedAt: _u, ...rest }) => rest);
    expect(strip(await rows(d.id))).toEqual(strip(one));
  });

  it("tenant isolation: another shop cannot save this design (NOT_FOUND) and nothing changes", async () => {
    const same = [placement("front", "iso")];
    const d = await make(same);
    await checkAll(d.id, [issue("error", "thin_line")]);
    const other = await createCompany();
    const ou = await createUser(other.id, "designer");
    const octx = tenantContext(other.id, ou.id, "designer");
    await expect(
      withTenant(other.id, (tx) =>
        svc.updateDesign(tx, octx, { id: d.id, name: "x", placements: [] }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await rows(d.id))[0]?.qaStatus).toBe("failed");
  });
});
