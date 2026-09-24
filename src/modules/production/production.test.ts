import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  designFiles,
  designs,
  jobs,
  orderItems,
  orderItemTransitions,
  reprints,
  scans,
  transfers,
  vendorConnections,
} from "../../db/schema";
import { DEFAULT_SHEET_SPEC } from "../../db/schema/vendors";
import { runJobInline } from "../../lib/queues";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { cancelOrder } from "../orders/service";
import { scrapCancelledJob } from "./jobs";

type NestReq = { items: { id: string; width_in: number; height_in: number }[] };

/* Imaging and S3 are mocked: nesting stacks designs in one column, compose records its input. */
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

describe("production: batch building, scans and reprints", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let presserCtx: ReturnType<typeof tenantContext>;
  let blackM: string;
  let blackL: string;
  let itemIds: string[];
  let oversizeId: string;

  beforeAll(async () => {
    const company = await createCompany();
    companyId = company.id;
    const owner = await createUser(companyId, "owner");
    const presser = await createUser(companyId, "presser");
    ctx = tenantContext(companyId, owner.id, "owner");
    presserCtx = tenantContext(companyId, presser.id, "presser");
    await createLocation(companyId);
    const conn = await createConnection(companyId);
    const { order, items } = await createOrder(companyId, conn.id, { units: 3, state: "ready" });
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
        .values({ companyId, code: "T100", name: "Saguaro Sunset" })
        .returning();
      if (!design) throw new Error("design");
      await tx.insert(designFiles).values({
        companyId,
        designId: design.id,
        placement: "front",
        fileKey: `${companyId}/design/t100.png`,
        widthIn: 11,
        heightIn: 12,
        qaStatus: "passed",
      });
      const variant = (size: string) => ({
        companyId,
        brand: "Gildan",
        style: "64000",
        styleCode: "64000",
        color: "Black",
        colorCode: "BLK",
        size,
        sizeCode: size,
        sku: `G64000-BLK-${size}`,
      });
      const [m, l] = await tx
        .insert(blankVariants)
        .values([variant("M"), variant("L")])
        .returning();
      if (!m || !l) throw new Error("blanks");
      blackM = m.id;
      blackL = l.id;
      for (const [i, item] of items.entries()) {
        await tx
          .update(orderItems)
          .set({
            designId: design.id,
            blankVariantId: blackM,
            placement: "front",
            isRush: i === 1,
            // The third unit's print size can't fit a 22in sheet.
            ...(i === 2 ? { printWidthIn: 30, printHeightIn: 30 } : {}),
          })
          .where(eq(orderItems.id, item.id));
      }
      void order;
    }, companyId);
    itemIds = items.slice(0, 2).map((i) => i.id);
    oversizeId = items[2]?.id as string;
  });

  const opts = {
    dueBefore: new Date(Date.now() + 5 * 86400_000).toISOString(),
    rushFirst: true,
    includeReprints: true,
    vendorConnectionId: null,
    maxSheets: null,
  };

  it("previews eligible items rush first and excludes what can't fit", async () => {
    const preview = await withTenant(companyId, (tx) => svc.previewBatch(tx, ctx, opts));
    expect(preview.items.map((i) => i.orderItemId)).toEqual([itemIds[1], itemIds[0]]);
    expect(preview.excluded).toEqual([
      expect.objectContaining({ orderItemId: oversizeId, reason: "oversize" }),
    ]);
    expect(preview.estimatedSheets).toBe(1);
    expect(preview.sheetWidthIn).toBe(22);
  });

  it("builds sheets: nest, compose, transfers and ready -> on_sheet", async () => {
    const ref = await withTenant(companyId, (tx) => svc.buildBatch(tx, ctx, opts));
    expect(ref.itemCount).toBe(2);
    await svc.runBuildSheets(companyId, ref.batchId, ref.jobId);

    const [job] = await withSystem((tx) => tx.select().from(jobs).where(eq(jobs.id, ref.jobId)));
    expect(job?.status).toBe("done");
    expect(job?.resultIds).toHaveLength(1);
    const sheet = await withTenant(companyId, (tx) =>
      svc.getSheet(tx, ctx, job?.resultIds[0] as string),
    );
    expect(sheet.status).toBe("ready");
    expect(sheet.placements).toHaveLength(2);
    expect(sheet.files.pngKey).toBeTruthy();
    expect(sheet.cost).toBe(Math.round(sheet.lengthIn * 30));

    const composed = imagingMock.compose.mock.calls.at(-1)?.[0] as unknown as {
      placements: { transfer_id: string; label: { size: string; design: string } }[];
    };
    expect(composed.placements).toHaveLength(2);
    expect(composed.placements[0]?.label).toMatchObject({ size: "M", design: "Saguaro Sunset" });

    const items = await withTenant(companyId, (tx) => svc.sheetItems(tx, ctx, sheet.id));
    expect(items.items.map((i) => i.state)).toEqual(["on_sheet", "on_sheet"]);
    expect(items.items.every((i) => i.transferId && i.sheetId === sheet.id)).toBe(true);

    // The oversize unit stays ready and is not on the sheet.
    const [left] = await withSystem((tx) =>
      tx.select().from(orderItems).where(eq(orderItems.id, oversizeId)),
    );
    expect(left?.state).toBe("ready");
    expect(left?.transferId).toBeNull();

    // Nothing left to build for this cutoff except the oversize unit.
    await expect(
      withTenant(companyId, (tx) => svc.buildBatch(tx, ctx, opts)),
    ).rejects.toMatchObject({
      code: "NOTHING_TO_BUILD",
    });

    // Vendor flow stand-in, then the shop receives the transfers.
    await withTenant(companyId, async (tx) => {
      const row = await svc.lockSheet(tx, sheet.id);
      const sent = await svc.transitionSheet(tx, companyId, ctx.actor, row, "sent");
      await svc.transitionSheet(tx, companyId, ctx.actor, sent, "printed");
    });
    const received = await withTenant(companyId, (tx) => svc.markSheetReceived(tx, ctx, sheet.id));
    expect(received.status).toBe("received");
    const after = await withTenant(companyId, (tx) => svc.sheetItems(tx, ctx, sheet.id));
    expect(after.items.map((i) => i.state)).toEqual(["transfer_in", "transfer_in"]);
  });

  const transferOf = async (itemId: string) => {
    const [row] = await withSystem((tx) =>
      tx.select().from(orderItems).where(eq(orderItems.id, itemId)),
    );
    return row?.transferId as string;
  };
  const scanInput = (
    transferId: string,
    blankCode: string | null,
    clientScanId = crypto.randomUUID(),
  ) => ({
    clientScanId,
    station: "press" as const,
    transferCode: `T:${transferId}`,
    blankCode,
    scannedAt: new Date().toISOString(),
  });

  it("blocks the wrong blank and presses the right one, idempotently", async () => {
    const id = itemIds[0] as string;
    const t = await transferOf(id);
    const wrong = await withTenant(companyId, (tx) =>
      svc.scan(tx, presserCtx, scanInput(t, `B:${blackL}`)),
    );
    expect(wrong).toMatchObject({ ok: false, mismatch: "wrong_size", itemState: "transfer_in" });
    expect(wrong.expected?.size).toBe("M");
    expect(wrong.scannedBlank?.size).toBe("L");

    const clientScanId = crypto.randomUUID();
    const ok = await withTenant(companyId, (tx) =>
      svc.scan(tx, presserCtx, scanInput(t, `B:${blackM}`, clientScanId)),
    );
    expect(ok).toMatchObject({ ok: true, mismatch: null, itemState: "pressed", nextAction: "qc" });

    // Offline replay of the same scan (even with a different second code) returns the stored result.
    const replay = await withTenant(companyId, (tx) =>
      svc.scan(tx, presserCtx, scanInput(t, `B:${blackL}`, clientScanId)),
    );
    expect(replay).toEqual(ok);
    const stored = await withSystem((tx) =>
      tx.select().from(scans).where(eq(scans.clientScanId, clientScanId)),
    );
    expect(stored).toHaveLength(1);
    const pressedMoves = await withSystem((tx) =>
      tx
        .select()
        .from(orderItemTransitions)
        .where(
          and(
            eq(orderItemTransitions.orderItemId, id),
            eq(orderItemTransitions.toState, "pressed"),
          ),
        ),
    );
    expect(pressedMoves).toHaveLength(1);

    // A new scan of the pressed transfer is "already processed", not a second press.
    const again = await withTenant(companyId, (tx) =>
      svc.scan(tx, presserCtx, scanInput(t, `B:${blackM}`)),
    );
    expect(again.mismatch).toBe("already_processed");
  });

  it("QC fail opens a reprint, scraps the transfer, and replays safely", async () => {
    const id = itemIds[0] as string;
    const oldTransfer = await transferOf(id);
    const fail = await withTenant(companyId, (tx) =>
      svc.qc(tx, presserCtx, {
        orderItemId: id,
        result: "fail",
        reprintReason: "peel",
        blankReusable: false,
        note: null,
      }),
    );
    expect(fail.item).toMatchObject({ state: "ready", isReprint: true, transferId: null });
    expect(fail.reprint).toMatchObject({
      reason: "peel",
      status: "requested",
      originalTransferId: oldTransfer,
    });

    const replay = await withTenant(companyId, (tx) =>
      svc.qc(tx, presserCtx, {
        orderItemId: id,
        result: "fail",
        reprintReason: "peel",
        blankReusable: false,
        note: null,
      }),
    );
    expect(replay.reprint?.id).toBe(fail.reprint?.id);
    const open = await withSystem((tx) =>
      tx.select().from(reprints).where(eq(reprints.orderItemId, id)),
    );
    expect(open).toHaveLength(1);

    const [scrap] = await withSystem((tx) =>
      tx.select().from(transfers).where(eq(transfers.id, oldTransfer)),
    );
    expect(scrap).toMatchObject({ scrapped: true, status: "scrap" });
    const stale = await withTenant(companyId, (tx) =>
      svc.scan(tx, presserCtx, scanInput(oldTransfer, `B:${blackM}`)),
    );
    expect(stale.mismatch).toBe("transfer_scrapped");

    // The reprint goes on the next batch, flagged.
    const preview = await withTenant(companyId, (tx) => svc.previewBatch(tx, ctx, opts));
    expect(preview.items).toEqual([expect.objectContaining({ orderItemId: id, isReprint: true })]);
    const ref = await withTenant(companyId, (tx) => svc.buildBatch(tx, ctx, opts));
    await svc.runBuildSheets(companyId, ref.batchId, ref.jobId);
    const [rp] = await withSystem((tx) =>
      tx.select().from(reprints).where(eq(reprints.orderItemId, id)),
    );
    expect(rp?.status).toBe("on_sheet");
    expect(rp?.newTransferId).toBe(await transferOf(id));
  });

  it("QC pass packs the unit and a replayed pass succeeds", async () => {
    const id = itemIds[1] as string;
    const t = await transferOf(id);
    await withTenant(companyId, (tx) => svc.scan(tx, presserCtx, scanInput(t, `B:${blackM}`)));
    const pass = await withTenant(companyId, (tx) =>
      svc.qc(tx, presserCtx, { orderItemId: id, result: "pass", blankReusable: false, note: null }),
    );
    expect(pass).toMatchObject({ item: { state: "packed" }, reprint: null });
    const replay = await withTenant(companyId, (tx) =>
      svc.qc(tx, presserCtx, { orderItemId: id, result: "pass", blankReusable: false, note: null }),
    );
    expect(replay.item.state).toBe("packed");
    const queue = await withTenant(companyId, (tx) =>
      svc.stationQueue(tx, presserCtx, { station: "qc", limit: 50 }),
    );
    expect(queue.items.find((i) => i.orderItemId === id)).toBeUndefined();
  });
  it("cancelling an order after its transfer is nested scraps the transfer", async () => {
    const conn = await createConnection(companyId);
    const { order, items } = await createOrder(companyId, conn.id, { units: 1, state: "ready" });
    const id = items[0]?.id as string;
    const [design] = await withSystem((tx) =>
      tx.select().from(designs).where(eq(designs.companyId, companyId)),
    );
    await withSystem(
      (tx) =>
        tx
          .update(orderItems)
          .set({ designId: design?.id, blankVariantId: blackM, placement: "front" })
          .where(eq(orderItems.id, id)),
      companyId,
    );
    const ref = await withTenant(companyId, (tx) => svc.buildBatch(tx, ctx, opts));
    await svc.runBuildSheets(companyId, ref.batchId, ref.jobId);
    const t = await transferOf(id);
    expect(t).toBeTruthy();

    const cancelled = await withTenant(companyId, (tx) =>
      cancelOrder(tx, ctx, { id: order.id, reason: "buyer_request", note: null }),
    );
    expect(cancelled.items[0]?.state).toBe("cancelled");
    // The worker reacts to order.cancelled the way the outbox relay would.
    await runJobInline(scrapCancelledJob, { companyId, orderId: order.id, transferIds: [t] });
    const [transfer] = await withSystem((tx) =>
      tx.select().from(transfers).where(eq(transfers.id, t)),
    );
    expect(transfer).toMatchObject({ scrapped: true, status: "scrap" });
    const [row] = await withSystem((tx) =>
      tx.select().from(orderItems).where(eq(orderItems.id, id)),
    );
    expect(row?.transferId).toBeNull();
  });
});
