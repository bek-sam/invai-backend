import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  designFiles,
  designs,
  gangSheetBatches,
  gangSheets,
  jobs,
  orderItems,
  outboxEvents,
  vendorConnections,
} from "../../db/schema";
import { DEFAULT_SHEET_SPEC } from "../../db/schema/vendors";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";

/*
 * B-343: the sheet and job error columns hold the scrubbed message head, never the `params:` tail
 * a driver error carries (a buyer value can sit in it).
 */

type NestReq = { items: { id: string; width_in: number; height_in: number }[] };
const imagingMock = vi.hoisted(() => ({
  nest: vi.fn(async (req: NestReq) => ({
    sheets: [
      {
        index: 0,
        length_in: 14,
        utilization: 0.5,
        placements: req.items.map((i, n) => ({
          id: i.id,
          copy: 0,
          x_in: 0.25,
          y_in: 0.25 + n * 13,
          width_in: i.width_in,
          height_in: i.height_in,
          rotated: false,
        })),
      },
    ],
  })),
  compose: vi.fn(async (req: { out_key: string; preview_key: string }) => ({
    key: req.out_key,
    preview_key: req.preview_key,
    width_px: 6600,
    height_px: 9000,
    bytes: 1000,
  })),
  isUp: vi.fn(async () => true),
}));
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return { ...actual, imaging: { ...actual.imaging, ...imagingMock } };
});
vi.mock("../../lib/s3", async (orig) => {
  const actual = await orig<typeof import("../../lib/s3")>();
  return {
    ...actual,
    headObject: vi.fn(async () => ({ exists: true, size: 1, contentType: "image/png" })),
  };
});

const svc = await import("./service");

const VALUE = "Maria Perez 4410 Mesquite Lane";
const drizzleErr = () => new Error(`Failed query: select 1\nparams: ${VALUE}`);

describe("production sheet errors are stored scrubbed (B-343)", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  const opts = {
    dueBefore: new Date(Date.now() + 5 * 86400_000).toISOString(),
    rushFirst: true,
    includeReprints: true,
    vendorConnectionId: null,
    maxSheets: null,
  };

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    await createLocation(companyId);
    const conn = await createConnection(companyId);
    const { items } = await createOrder(companyId, conn.id, { units: 1, state: "ready" });
    await withSystem(async (tx) => {
      await tx.insert(vendorConnections).values({
        companyId,
        name: "Test DTF",
        email: "dtf@test.local",
        status: "active",
        delivery: "email",
        spec: DEFAULT_SHEET_SPEC,
        isDefault: true,
      });
      const [design] = await tx
        .insert(designs)
        .values({ companyId, code: "T200", name: "Saguaro" })
        .returning();
      if (!design) throw new Error("design");
      await tx.insert(designFiles).values({
        companyId,
        designId: design.id,
        placement: "front",
        fileKey: `${companyId}/design/t200.png`,
        widthIn: 11,
        heightIn: 12,
        qaStatus: "passed",
      });
      const [m] = await tx
        .insert(blankVariants)
        .values({
          companyId,
          brand: "Gildan",
          style: "64000",
          styleCode: "64000",
          color: "Black",
          colorCode: "BLK",
          size: "M",
          sizeCode: "M",
          sku: "G64000-BLK-M",
        })
        .returning();
      await tx
        .update(orderItems)
        .set({ designId: design.id, blankVariantId: m?.id, placement: "front" })
        .where(eq(orderItems.id, items[0]?.id as string));
    }, companyId);
  });

  const jobRow = async (id: string) =>
    (await withSystem((tx) => tx.select().from(jobs).where(eq(jobs.id, id))))[0];

  it("a failed nest on build stores the head in jobs.error and the batch error", async () => {
    imagingMock.nest.mockRejectedValueOnce(drizzleErr());
    const ref = await withTenant(companyId, (tx) => svc.buildBatch(tx, ctx, opts));
    await svc.runBuildSheets(companyId, ref.batchId, ref.jobId);
    const job = await jobRow(ref.jobId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/^Failed query/);
    expect(job?.error).not.toContain(VALUE);
    const [batch] = await withSystem((tx) =>
      tx.select().from(gangSheetBatches).where(eq(gangSheetBatches.id, ref.batchId)),
    );
    expect(batch?.error).not.toContain(VALUE);
  });

  it("a failed compose stores the head in the sheet error and the build_failed event", async () => {
    const batchRef = await withTenant(companyId, (tx) => svc.buildBatch(tx, ctx, opts));
    imagingMock.compose.mockRejectedValueOnce(drizzleErr());
    await svc.runBuildSheets(companyId, batchRef.batchId, batchRef.jobId);
    const sheets = await withSystem((tx) =>
      tx.select().from(gangSheets).where(eq(gangSheets.batchId, batchRef.batchId)),
    );
    const failed = sheets.filter((s) => s.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
    for (const s of failed) {
      expect(s.error).toMatch(/^Failed query/);
      expect(s.error).not.toContain(VALUE);
    }
    const events = await withSystem((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.companyId, companyId)),
    );
    const built = events.filter((e) => e.name === "sheet.build_failed");
    expect(built.length).toBeGreaterThan(0);
    expect(JSON.stringify(built.map((e) => e.payload))).not.toContain(VALUE);
  });

  it("a failed re-nest stores the head in the sheet error and jobs.error", async () => {
    const [existing] = await withSystem((tx) =>
      tx.select().from(gangSheets).where(eq(gangSheets.companyId, companyId)),
    );
    const sheetId = existing?.id as string;
    expect(sheetId).toBeTruthy();
    const regen = await withTenant(companyId, (tx) => svc.regenerateSheet(tx, ctx, sheetId));
    imagingMock.nest.mockRejectedValueOnce(drizzleErr());
    await svc.runRegenerateSheet(companyId, sheetId, regen.jobId);
    const job = await jobRow(regen.jobId);
    expect(job?.error).toMatch(/^Failed query/);
    expect(job?.error).not.toContain(VALUE);
    const [sheet] = await withSystem((tx) =>
      tx.select().from(gangSheets).where(eq(gangSheets.id, sheetId)),
    );
    expect(sheet?.status).toBe("failed");
    expect(sheet?.error).toMatch(/^Failed query/);
    expect(sheet?.error).not.toContain(VALUE);
  });
});
