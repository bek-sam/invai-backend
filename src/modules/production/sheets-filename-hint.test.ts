import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  designFiles,
  designs,
  gangSheets,
  jobs,
  orderItems,
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
 * T-49-1 (S-86, AC2): the filename hint sent to imaging is cut on a whole character. The real
 * sheet build and regenerate paths run; only the imaging client and the S3 head check are doubles.
 */

type NestReq = { items: { id: string; width_in: number; height_in: number }[] };
const imagingMock = vi.hoisted(() => ({
  nest: vi.fn(async (req: NestReq) => {
    let y = 0.25;
    const placements = req.items.map((i) => {
      const p = {
        id: i.id,
        copy: 0,
        x_in: 0.25,
        y_in: y,
        width_in: i.width_in,
        height_in: i.height_in,
        rotated: false,
      };
      y += i.height_in + 0.6;
      return p;
    });
    return { sheets: [{ index: 0, length_in: y + 0.25, utilization: 0.5, placements }] };
  }),
  compose: vi.fn(async (req: { out_key: string; preview_key: string; filename_hint?: string }) => ({
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
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("sheet compose: filename hint (S-86)", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let sheetId: string;

  beforeAll(async () => {
    const company = await createCompany();
    companyId = company.id;
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
        .values({ companyId, code: "H100", name: "Hint Design" })
        .returning();
      if (!design) throw new Error("design");
      await tx.insert(designFiles).values({
        companyId,
        designId: design.id,
        placement: "front",
        fileKey: `${companyId}/design/h100.png`,
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
      if (!m) throw new Error("blank");
      await tx
        .update(orderItems)
        .set({ designId: design.id, blankVariantId: m.id, placement: "front" })
        .where(eq(orderItems.id, items[0]?.id as string));
    }, companyId);
    const ref = await withTenant(companyId, (tx) =>
      svc.buildBatch(tx, ctx, {
        dueBefore: new Date(Date.now() + 5 * 86400_000).toISOString(),
        rushFirst: true,
        includeReprints: true,
        vendorConnectionId: null,
        maxSheets: null,
      }),
    );
    await svc.runBuildSheets(companyId, ref.batchId, ref.jobId);
    const [job] = await withSystem((tx) => tx.select().from(jobs).where(eq(jobs.id, ref.jobId)));
    sheetId = job?.resultIds[0] as string;
  });

  it("a sheet name with an emoji across unit 150 composes with a clean hint", async () => {
    const name = `${"s".repeat(149)}😀 and more`;
    await withTenant(companyId, (tx) =>
      tx.update(gangSheets).set({ name }).where(eq(gangSheets.id, sheetId)),
    );
    const { jobId } = await withTenant(companyId, (tx) => svc.regenerateSheet(tx, ctx, sheetId));
    imagingMock.compose.mockClear();
    await svc.runRegenerateSheet(companyId, sheetId, jobId);
    expect(imagingMock.compose).toHaveBeenCalledTimes(1);
    const sent = imagingMock.compose.mock.calls[0]?.[0] as { filename_hint?: string };
    expect(sent.filename_hint).toBeDefined();
    const hint = sent.filename_hint as string;
    expect(hint.length).toBeLessThanOrEqual(150);
    expect(LONE.test(hint)).toBe(false);
    expect(hint).toBe("s".repeat(149));
  });
});
