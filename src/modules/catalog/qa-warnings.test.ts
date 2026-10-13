import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { call } from "@orpc/server";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withTenant } from "../../db/client";
import type { QaIssue } from "../../db/schema";
import {
  aiCreditLedger,
  aiJobs,
  auditLog,
  designFiles,
  orderItems,
  outboxEvents,
} from "../../db/schema";
import { ImagingError } from "../../integrations/imaging/client";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { classify } from "../production/sheets";
import { setQaCooldown } from "./qa-turn";

/*
 * T-42-5 (B-380 C3): imaging stubbed; everything else runs against invai_test with RLS.
 */
const img = vi.hoisted(() => ({
  qaCheck: vi.fn(),
  cleanAlpha: vi.fn(),
  isUp: vi.fn(async () => true),
}));
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return {
    ...actual,
    imaging: {
      ...actual.imaging,
      qaCheck: img.qaCheck,
      cleanAlpha: img.cleanAlpha,
      isUp: img.isUp,
    },
  };
});

import { createImagingClient } from "../../integrations/imaging/client";
import * as svc from "./service";

const result = (issues: unknown[]) => ({
  width_px: 3000,
  height_px: 3000,
  has_alpha: true,
  soft_alpha_ratio: 0,
  effective_dpi: 300,
  issues,
});
const warn = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  severity: "warn" as const,
  message: `${code} warning`,
  ...extra,
});
const err = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  severity: "error" as const,
  message: `${code} error`,
  ...extra,
});

beforeAll(() => setQaCooldown(0)); // S-81: several turns in a row per company

describe("QA warnings (T-42-5)", () => {
  let companyId: string;
  let otherCompanyId: string;
  let designer: { id: string; name: string };
  let designer2: { id: string; name: string };
  let ctx: ReturnType<typeof tenantContext>;
  let n = 0;

  const as = (u: { id: string; name: string }, role: "designer" | "admin" | "office" | "presser") =>
    ({
      ...tenantContext(companyId, u.id, role),
      user: { id: u.id, name: u.name, email: "x@test.local" },
    }) as ReturnType<typeof tenantContext>;

  const routerCtx = (
    cid: string,
    u: { id: string; name: string },
    role: "designer" | "admin" | "office" | "presser" | "owner",
  ) => ({
    ...anonymousContext(new Headers(), null),
    sessionKind: "user" as const,
    user: { id: u.id, name: u.name, email: "x@test.local" },
    companyId: cid,
    orgType: "shop" as const,
    role,
    permissions: permissionsFor(role),
  });

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    otherCompanyId = (await createCompany()).id;
    designer = await createUser(companyId, "designer", { name: "Dana Designer" });
    designer2 = await createUser(companyId, "designer", { name: "Dev Designer" });
    ctx = as(designer, "designer");
  });

  beforeEach(() => {
    img.qaCheck.mockReset();
    img.cleanAlpha.mockReset();
    img.isUp.mockResolvedValue(true);
  });

  /** A design with one front file, QA run once with `issues`. */
  async function designWith(issues: unknown[], opts: { key?: string } = {}) {
    n++;
    img.qaCheck.mockResolvedValue(result(issues));
    const created = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, ctx, {
        code: `QW${n}-${Math.random().toString(36).slice(2, 6)}`,
        name: `QA ${n}`,
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: opts.key ?? `${companyId}/design/qa-${n}.png`,
            widthIn: 10,
            heightIn: 10,
          },
        ],
        personalizationTemplateId: null,
      }),
    );
    return withTenant(companyId, (tx) => svc.runDesignQa(tx, ctx, created.id));
  }

  const front = (d: { placements: { placement: string; qa: { issues: QaIssue[] } }[] }) =>
    d.placements.find((p) => p.placement === "front")?.qa.issues ?? [];

  const accept = (id: string, code: string, c = ctx) =>
    withTenant(companyId, (tx) => svc.acceptQaWarning(tx, c, { id, placement: "front", code }));
  const unaccept = (id: string, code: string, c = ctx) =>
    withTenant(companyId, (tx) => svc.unacceptQaWarning(tx, c, { id, placement: "front", code }));

  /* ---------------------------- criterion 1: fields survive ---------------------------- */

  describe("imaging client schema", () => {
    let server: Server;
    let url: string;
    let body: unknown;
    beforeAll(async () => {
      server = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const run = async (issues: unknown[]) => {
      body = { width_px: 1, height_px: 1, has_alpha: true, soft_alpha_ratio: 0, issues };
      const c = createImagingClient(url, 5_000, "s");
      return (await c.qaCheck({ file_key: "k" })).issues;
    };

    it("maps measured_in to measuredIn and keeps regions", async () => {
      const [i] = await run([
        {
          code: "thin_line",
          severity: "error",
          message: "m",
          measured_in: 0.0153,
          regions: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.4 }],
        },
      ]);
      expect(i).toEqual({
        code: "thin_line",
        severity: "error",
        message: "m",
        measuredIn: 0.0153,
        regions: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.4 }],
      });
    });

    it("treats null as absent and drops a non-positive measuredIn", async () => {
      const out = await run([
        { code: "a", severity: "warn", message: "m", measured_in: null, regions: null },
        { code: "b", severity: "warn", message: "m", measured_in: 0 },
        { code: "c", severity: "warn", message: "m", measured_in: -1, regions: [] },
        { code: "d", severity: "warn", message: "m" },
      ]);
      for (const i of out) {
        expect(i).not.toHaveProperty("measuredIn");
        expect(i).not.toHaveProperty("regions");
        expect(i).not.toHaveProperty("measured_in");
      }
    });

    it("clamps region ratios to 0..1 and keeps the first 20", async () => {
      const regions = Array.from({ length: 25 }, (_, k) => ({
        left: k === 0 ? -0.5 : 0.1,
        top: k === 0 ? 1.7 : 0.1,
        width: 0.2,
        height: 0.2,
      }));
      const [i] = await run([{ code: "thin_line", severity: "warn", message: "m", regions }]);
      expect(i?.regions).toHaveLength(20);
      expect(i?.regions?.[0]).toEqual({ left: 0, top: 1, width: 0.2, height: 0.2 });
    });
  });

  it("stores measuredIn and regions and returns them on get; drops an unknown code", async () => {
    const regions = [{ left: 0.1, top: 0.1, width: 0.2, height: 0.2 }];
    const d = await designWith([
      err("thin_line", { measuredIn: 0.015, regions }),
      warn("brand_new_code_from_the_future"),
    ]);
    const got = await withTenant(companyId, (tx) => svc.getDesign(tx, ctx, d.id));
    const issues = front(got);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "thin_line", measuredIn: 0.015, regions });
    expect(got.placements[0]?.qa.status).toBe("failed");
  });

  /* ------------------------------- criteria 13, 14, 30 ------------------------------- */

  it("accepts a warning: stamps who and when, status stays warn, second call is idempotent", async () => {
    const d = await designWith([warn("white_box")]);
    const before = await withTenant(companyId, (tx) =>
      tx.select({ c: count() }).from(auditLog).where(eq(auditLog.entityId, d.id)),
    );
    const a = await accept(d.id, "white_box");
    const issue = front(a)[0];
    expect(issue?.acceptedBy).toBe("Dana Designer");
    expect(Number.isNaN(Date.parse(issue?.acceptedAt ?? ""))).toBe(false);
    expect(a.placements[0]?.qa.status).toBe("warn");
    expect(a.qaStatus).toBe("warn");
    // A second designer repeating it changes nothing: same time, same name.
    const b = await accept(d.id, "white_box", as(designer2, "designer"));
    expect(front(b)[0]).toMatchObject({
      acceptedAt: issue?.acceptedAt,
      acceptedBy: "Dana Designer",
    });
    const after = await withTenant(companyId, (tx) =>
      tx.select({ c: count() }).from(auditLog).where(eq(auditLog.entityId, d.id)),
    );
    expect((after[0]?.c ?? 0) - (before[0]?.c ?? 0)).toBe(1);
  });

  it("caps a very long display name at 200 characters so accept, list and get keep working", async () => {
    const longName = ` ${"N".repeat(250)} `;
    const wordy = await createUser(companyId, "designer", { name: longName });
    const d = await designWith([warn("white_box")]);
    const input = { id: d.id, placement: "front" as const, code: "white_box" as const };
    const ok = await call(router.designs.acceptQaWarning, input, {
      context: routerCtx(companyId, wordy, "designer"),
    });
    expect(front(ok)[0]?.acceptedBy).toHaveLength(200);
    const ctxOf = { context: routerCtx(companyId, wordy, "designer") };
    const list = await call(router.designs.list, { limit: 50 }, ctxOf);
    expect(list.items.some((x) => x.id === d.id)).toBe(true);
    const got = await call(router.designs.get, { id: d.id }, ctxOf);
    expect(front(got)[0]?.acceptedBy).toHaveLength(200);
  });

  it("refuses an error (QA_NOT_WARNING) and a missing code or placement (QA_ISSUE_NOT_FOUND)", async () => {
    const d = await designWith([err("thin_line"), warn("non_srgb")]);
    await expect(accept(d.id, "thin_line")).rejects.toMatchObject({
      code: "QA_NOT_WARNING",
      status: 409,
    });
    await expect(accept(d.id, "white_box")).rejects.toMatchObject({
      code: "QA_ISSUE_NOT_FOUND",
      status: 404,
    });
    await expect(
      withTenant(companyId, (tx) =>
        svc.acceptQaWarning(tx, ctx, { id: d.id, placement: "back", code: "non_srgb" }),
      ),
    ).rejects.toMatchObject({ code: "QA_ISSUE_NOT_FOUND" });
    expect(front(await withTenant(companyId, (tx) => svc.getDesign(tx, ctx, d.id)))).toEqual(
      expect.arrayContaining([expect.not.objectContaining({ acceptedAt: expect.anything() })]),
    );
  });

  it("undo clears both fields, status stays warn; another person can undo; not accepted is a no-op", async () => {
    const d = await designWith([warn("white_box")]);
    const untouched = await unaccept(d.id, "white_box");
    expect(front(untouched)[0]).not.toHaveProperty("acceptedAt");
    const audits = () =>
      withTenant(companyId, (tx) =>
        tx.select({ c: count() }).from(auditLog).where(eq(auditLog.entityId, d.id)),
      );
    const a0 = (await audits())[0]?.c;
    await accept(d.id, "white_box");
    const undone = await unaccept(d.id, "white_box", as(designer2, "designer"));
    const issue = front(undone)[0];
    expect(issue).not.toHaveProperty("acceptedAt");
    expect(issue).not.toHaveProperty("acceptedBy");
    expect(undone.placements[0]?.qa.status).toBe("warn");
    // accept (1 row) + undo (1 row); the first no-op undo wrote none
    expect((await audits())[0]?.c).toBe((a0 ?? 0) + 2);
    await unaccept(d.id, "white_box");
    expect((await audits())[0]?.c).toBe((a0 ?? 0) + 2);
    await expect(unaccept(d.id, "thin_line")).rejects.toMatchObject({
      code: "QA_ISSUE_NOT_FOUND",
    });
  });

  it("accept and undo run no imaging, raise no design.updated, touch no AI tables", async () => {
    const d = await designWith([warn("white_box")]);
    const snap = () =>
      withTenant(companyId, async (tx) => ({
        events: (await tx.select({ c: count() }).from(outboxEvents))[0]?.c,
        ai: (await tx.select({ c: count() }).from(aiJobs))[0]?.c,
        ledger: (await tx.select({ c: count() }).from(aiCreditLedger))[0]?.c,
      }));
    const calls = img.qaCheck.mock.calls.length;
    const s0 = await snap();
    await accept(d.id, "white_box");
    await unaccept(d.id, "white_box");
    expect(img.qaCheck.mock.calls.length).toBe(calls);
    expect(await snap()).toEqual(s0);
  });

  /* ------------------------------ acceptance across re-runs ------------------------------ */

  it("keeps acceptance on a re-run of the same file; a new file key or an error drops it", async () => {
    const d = await designWith([warn("white_box"), warn("non_srgb")]);
    await accept(d.id, "white_box");
    // Same key, same warnings: kept (and only on the accepted one).
    img.qaCheck.mockResolvedValue(result([warn("white_box"), warn("non_srgb")]));
    let r = await withTenant(companyId, (tx) => svc.runDesignQa(tx, ctx, d.id));
    expect(front(r).find((i) => i.code === "white_box")?.acceptedBy).toBe("Dana Designer");
    expect(front(r).find((i) => i.code === "non_srgb")).not.toHaveProperty("acceptedAt");
    // cleanAlpha writes a new key: acceptance dropped (on purpose).
    img.cleanAlpha.mockResolvedValue({ key: `${companyId}/design/cleaned.png` });
    r = await withTenant(companyId, (tx) => svc.runDesignQa(tx, ctx, d.id, { cleanAlpha: true }));
    expect(front(r).find((i) => i.code === "white_box")).not.toHaveProperty("acceptedAt");
    // Accept again, then the same code comes back as an error: no acceptance on an error.
    await accept(d.id, "white_box");
    img.qaCheck.mockResolvedValue(result([err("white_box")]));
    r = await withTenant(companyId, (tx) => svc.runDesignQa(tx, ctx, d.id));
    expect(front(r)[0]).toMatchObject({ severity: "error" });
    expect(front(r)[0]).not.toHaveProperty("acceptedAt");
  });

  it("an accept that lands while imaging is answering survives the QA write (A7)", async () => {
    const d = await designWith([warn("white_box")]);
    img.qaCheck.mockImplementation(async () => {
      await accept(d.id, "white_box", as(designer2, "designer"));
      return result([warn("white_box")]);
    });
    const r = await withTenant(companyId, (tx) => svc.runDesignQa(tx, ctx, d.id));
    expect(front(r)[0]?.acceptedBy).toBe("Dev Designer");
  });

  it("saving the design keeps issues and acceptance while file and size are unchanged (A6)", async () => {
    const d = await designWith([warn("white_box")]);
    await accept(d.id, "white_box");
    const same = {
      placement: "front" as const,
      fileKey: d.placements[0]?.fileKey as string,
      widthIn: 10,
      heightIn: 10,
    };
    let u = await withTenant(companyId, (tx) =>
      svc.updateDesign(tx, ctx, { id: d.id, name: "Renamed", placements: [same] }),
    );
    expect(front(u)[0]?.acceptedBy).toBe("Dana Designer");
    // A different size: nothing carried over.
    u = await withTenant(companyId, (tx) =>
      svc.updateDesign(tx, ctx, { id: d.id, placements: [{ ...same, widthIn: 11 }] }),
    );
    expect(front(u)).toEqual([]);
    // A different file: nothing carried over.
    img.qaCheck.mockResolvedValue(result([warn("white_box")]));
    await withTenant(companyId, (tx) => svc.runDesignQa(tx, ctx, d.id));
    await accept(d.id, "white_box");
    u = await withTenant(companyId, (tx) =>
      svc.updateDesign(tx, ctx, {
        id: d.id,
        placements: [{ ...same, widthIn: 11, fileKey: `${companyId}/design/other.png` }],
      }),
    );
    expect(front(u)).toEqual([]);
  });

  /* --------------------------------- permissions, tenancy --------------------------------- */

  it("office, presser and anonymous are refused; other shop gets NOT_FOUND", async () => {
    const d = await designWith([warn("white_box")]);
    const office = await createUser(companyId, "office");
    const presser = await createUser(companyId, "presser");
    const admin = await createUser(companyId, "admin", { name: "Ada Admin" });
    const input = { id: d.id, placement: "front" as const, code: "white_box" as const };
    for (const proc of [router.designs.acceptQaWarning, router.designs.unacceptQaWarning]) {
      for (const [u, role] of [
        [office, "office"],
        [presser, "presser"],
      ] as const) {
        await expect(
          call(proc, input, { context: routerCtx(companyId, u, role) }),
        ).rejects.toMatchObject({ code: "FORBIDDEN", data: { permission: "catalog.manage" } });
      }
      await expect(
        call(proc, input, { context: anonymousContext(new Headers(), null) }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    // Still untouched after all the refusals.
    expect(
      front(await withTenant(companyId, (tx) => svc.getDesign(tx, ctx, d.id)))[0],
    ).not.toHaveProperty("acceptedAt");

    const ok = await call(router.designs.acceptQaWarning, input, {
      context: routerCtx(companyId, designer, "designer"),
    });
    expect(front(ok)[0]?.acceptedBy).toBe("Dana Designer");
    const undone = await call(router.designs.unacceptQaWarning, input, {
      context: routerCtx(companyId, admin, "admin"),
    });
    expect(front(undone)[0]).not.toHaveProperty("acceptedAt");

    const stranger = await createUser(otherCompanyId, "designer");
    for (const proc of [router.designs.acceptQaWarning, router.designs.unacceptQaWarning]) {
      await expect(
        call(proc, input, { context: routerCtx(otherCompanyId, stranger, "designer") }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  /* ------------------------------ imaging down, states, sheets ------------------------------ */

  it("imaging down: fails as upstream and keeps the previous issues and acceptance (AC19)", async () => {
    const d = await designWith([warn("white_box")]);
    await accept(d.id, "white_box");
    img.qaCheck.mockRejectedValue(new ImagingError("/qa/check", 0, "connection refused"));
    await expect(
      withTenant(companyId, (tx) => svc.runDesignQa(tx, ctx, d.id)),
    ).rejects.toMatchObject({ code: "UPSTREAM_FAILED" });
    const got = await withTenant(companyId, (tx) => svc.getDesign(tx, ctx, d.id));
    expect(got.placements[0]?.qa.status).toBe("warn");
    expect(front(got)[0]?.acceptedBy).toBe("Dana Designer");
  });

  it("a re-run never changes item state and makes no AI call or credit change (AC20-22, 24)", async () => {
    const d = await designWith([warn("thin_line", { measuredIn: 0.025 })]);
    const conn = await createConnection(companyId);
    const { items } = await createOrder(companyId, conn.id, { units: 2 });
    const [a, b] = items;
    await withTenant(companyId, async (tx) => {
      await tx
        .update(orderItems)
        .set({ designId: d.id, state: "on_sheet" })
        .where(eq(orderItems.id, a?.id as string));
      await tx
        .update(orderItems)
        .set({ designId: d.id, state: "on_hold" })
        .where(eq(orderItems.id, b?.id as string));
    });
    const ai = () =>
      withTenant(companyId, async (tx) => [
        (await tx.select({ c: count() }).from(aiJobs))[0]?.c,
        (await tx.select({ c: count() }).from(aiCreditLedger))[0]?.c,
      ]);
    const before = await ai();
    img.qaCheck.mockResolvedValue(result([err("thin_line", { measuredIn: 0.01 })]));
    await withTenant(companyId, (tx) => svc.runDesignQa(tx, ctx, d.id));
    const rows = await withTenant(companyId, (tx) =>
      tx.select({ id: orderItems.id, state: orderItems.state }).from(orderItems),
    );
    expect(rows.find((r) => r.id === a?.id)?.state).toBe("on_sheet");
    expect(rows.find((r) => r.id === b?.id)?.state).toBe("on_hold");
    expect(await ai()).toEqual(before);
    // One imaging check per placement per run: the count today, pinned (AC23).
    img.qaCheck.mockClear();
    await withTenant(companyId, (tx) => svc.runDesignQa(tx, ctx, d.id));
    expect(img.qaCheck).toHaveBeenCalledTimes(1);
  });

  it("the sheet builder skips an error file (first print and reprint) but takes thin_line + non_srgb warnings (AC2)", async () => {
    const spec = { maxWidthIn: 22, maxLengthIn: 60 } as never;
    const file = async (issues: unknown[]) => {
      const d = await designWith(issues);
      const row = await withTenant(
        companyId,
        async (tx) =>
          (await tx.select().from(designFiles).where(eq(designFiles.designId, d.id)))[0],
      );
      return { d, row };
    };
    const view = (designId: string, isReprint: boolean) =>
      ({
        item: {
          state: "ready",
          transferId: null,
          blankVariantId: "blank",
          printWidthIn: null,
          printHeightIn: null,
          isReprint,
        },
        design: { id: designId, name: "d", code: "c", templateId: null },
      }) as never;

    const warned = await file([warn("thin_line", { measuredIn: 0.025 }), warn("non_srgb")]);
    expect(warned.row?.qaStatus).toBe("warn");
    expect(classify(view(warned.d.id, false), warned.row ?? null, spec).reason).not.toBe(
      "artwork_qa_failed",
    );
    const failed = await file([err("thin_line", { measuredIn: 0.015 }), warn("non_srgb")]);
    expect(failed.row?.qaStatus).toBe("failed");
    for (const reprint of [false, true])
      expect(classify(view(failed.d.id, reprint), failed.row ?? null, spec).reason).toBe(
        "artwork_qa_failed",
      );
  });

  /* ------------------------------- orders: worst severity ------------------------------- */

  it("setItemArtwork flags once per code with the worst severity, in either order (AC12)", async () => {
    const conn = await createConnection(companyId);
    const run = async (issues: unknown[]) => {
      const { items } = await createOrder(companyId, conn.id, { state: "ready" });
      const id = items[0]?.id as string;
      img.qaCheck.mockResolvedValue(result(issues));
      const { setItemArtwork } = await import("../orders/service");
      await withTenant(companyId, (tx) =>
        setItemArtwork(tx, ctx, { id, fileKey: `${companyId}/art/${id}.png` }),
      );
      const [row] = await withTenant(companyId, (tx) =>
        tx.select({ flags: orderItems.flags }).from(orderItems).where(eq(orderItems.id, id)),
      );
      return row?.flags ?? [];
    };
    for (const issues of [
      [err("thin_line"), warn("non_srgb")],
      [warn("non_srgb"), err("thin_line")],
    ]) {
      const flags = (await run(issues)).filter((f) => f.code === "artwork_qa_failed");
      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject({ severity: "error", message: "thin_line error" });
    }
    // Warnings only: a warning flag; low_dpi keeps its own code.
    const w = await run([warn("white_box"), warn("low_dpi")]);
    expect(w.find((f) => f.code === "artwork_qa_failed")?.severity).toBe("warn");
    expect(w.find((f) => f.code === "artwork_low_dpi")).toBeTruthy();
  });
});
