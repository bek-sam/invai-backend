import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  channelConnections,
  companies,
  gangSheetBatches,
  gangSheets,
  reprints,
} from "../../db/schema";
import { createCompany, createOrder, tenantContext } from "../../test/fixtures";
import {
  archiveBin,
  binLabels,
  createBin,
  listBins,
  renameBin,
  reprintReasonsByWeek,
} from "./floor";
import { assignBin } from "./service";
import { markSheetPrinted, markSheetPrinting } from "./sheets";

async function setPrintsInHouse(companyId: string, value: boolean) {
  await withSystem((tx) =>
    tx
      .update(companies)
      .set({ settings: { printsInHouse: value } })
      .where(eq(companies.id, companyId)),
  );
}

async function makeSheet(
  companyId: string,
  status: "building" | "ready" | "printing" | "sent" | "acknowledged" = "ready",
) {
  return withSystem(async (tx) => {
    const [batch] = await tx
      .insert(gangSheetBatches)
      .values({ companyId, name: "Batch 1" })
      .returning();
    if (!batch) throw new Error("batch insert failed");
    const [sheet] = await tx
      .insert(gangSheets)
      .values({ companyId, batchId: batch.id, name: "Sheet 1", status })
      .returning();
    if (!sheet) throw new Error("sheet insert failed");
    return sheet;
  });
}

describe("markSheetPrinting / markSheetPrinted (in-house path)", () => {
  it("refuses when the company doesn't print in-house", async () => {
    const shop = await createCompany();
    const ctx = tenantContext(shop.id, null, "owner");
    const sheet = await makeSheet(shop.id, "ready");
    await expect(
      withTenant(shop.id, (tx) => markSheetPrinting(tx, ctx, sheet.id)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ready -> printing -> printed, skipping the vendor", async () => {
    const shop = await createCompany();
    await setPrintsInHouse(shop.id, true);
    const ctx = tenantContext(shop.id, null, "owner");
    const sheet = await makeSheet(shop.id, "ready");

    const printing = await withTenant(shop.id, (tx) => markSheetPrinting(tx, ctx, sheet.id));
    expect(printing.status).toBe("printing");

    const printed = await withTenant(shop.id, (tx) => markSheetPrinted(tx, ctx, sheet.id));
    expect(printed.status).toBe("printed");
    expect(printed.printedAt).not.toBeNull();
  });

  it("refuses from a non-ready state", async () => {
    const shop = await createCompany();
    await setPrintsInHouse(shop.id, true);
    const ctx = tenantContext(shop.id, null, "owner");
    const sheet = await makeSheet(shop.id, "building");
    await expect(
      withTenant(shop.id, (tx) => markSheetPrinting(tx, ctx, sheet.id)),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("refuses to mark a vendor-path (sent) sheet printed, even though SHEET_TRANSITIONS allows sent -> printed", async () => {
    const shop = await createCompany();
    // printsInHouse is false: a vendor-only shop.
    const ctx = tenantContext(shop.id, null, "owner");
    const sheet = await makeSheet(shop.id, "sent");
    await expect(
      withTenant(shop.id, (tx) => markSheetPrinted(tx, ctx, sheet.id)),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const [row] = await withSystem((tx) =>
      tx.select().from(gangSheets).where(eq(gangSheets.id, sheet.id)),
    );
    expect(row?.status).toBe("sent");
    expect(row?.printedAt).toBeNull();
  });

  it("refuses markSheetPrinted on an acknowledged vendor sheet even when the company prints in-house", async () => {
    const shop = await createCompany();
    await setPrintsInHouse(shop.id, true);
    const ctx = tenantContext(shop.id, null, "owner");
    const sheet = await makeSheet(shop.id, "acknowledged");
    await expect(
      withTenant(shop.id, (tx) => markSheetPrinted(tx, ctx, sheet.id)),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
});

describe("bin CRUD", () => {
  it("creates, renames, lists and archives a bin", async () => {
    const shop = await createCompany();
    const ctx = tenantContext(shop.id, null, "owner");

    const bin = await withTenant(shop.id, (tx) =>
      createBin(tx, ctx, { code: "A1", name: "Shelf A1" }),
    );
    expect(bin.code).toBe("A1");
    expect(bin.name).toBe("Shelf A1");
    expect(bin.archivedAt).toBeNull();

    await expect(
      withTenant(shop.id, (tx) => createBin(tx, ctx, { code: "A1", name: null })),
    ).rejects.toMatchObject({ code: "CODE_TAKEN" });

    const renamed = await withTenant(shop.id, (tx) =>
      renameBin(tx, ctx, { id: bin.id, name: "Shelf A1 (front)" }),
    );
    expect(renamed.name).toBe("Shelf A1 (front)");

    const archived = await withTenant(shop.id, (tx) => archiveBin(tx, ctx, { id: bin.id }));
    expect(archived.archivedAt).not.toBeNull();

    const excluded = await withTenant(shop.id, (tx) =>
      listBins(tx, ctx, { onlyOccupied: false, includeArchived: false }),
    );
    expect(excluded.items.some((b) => b.id === bin.id)).toBe(false);

    const included = await withTenant(shop.id, (tx) =>
      listBins(tx, ctx, { onlyOccupied: false, includeArchived: true }),
    );
    expect(included.items.some((b) => b.id === bin.id)).toBe(true);
  });

  it("refuses to archive an occupied bin", async () => {
    const shop = await createCompany();
    const ctx = tenantContext(shop.id, null, "owner");
    const connection = await withSystem(async (tx) => {
      const [row] = await tx
        .insert(channelConnections)
        .values({
          companyId: shop.id,
          channel: "csv",
          name: "csv",
          status: "csv_only",
          mode: "csv",
        })
        .returning();
      return row;
    });
    if (!connection) throw new Error("connection insert failed");
    const { order } = await createOrder(shop.id, connection.id);
    const bin = await withTenant(shop.id, (tx) => createBin(tx, ctx, { code: "B1", name: null }));
    await withTenant(shop.id, (tx) => assignBin(tx, ctx, { code: "B1", orderId: order.id }));
    await expect(
      withTenant(shop.id, (tx) => archiveBin(tx, ctx, { id: bin.id })),
    ).rejects.toMatchObject({ code: "BIN_OCCUPIED" });
  });
});

describe("binLabels", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts BIN:<code> QR items to imaging and returns its key", async () => {
    const shop = await createCompany();
    const ctx = tenantContext(shop.id, null, "owner");
    const bin = await withTenant(shop.id, (tx) =>
      createBin(tx, ctx, { code: "A1", name: "Shelf A1" }),
    );

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.labels).toEqual([{ code: "BIN:A1", caption: "Shelf A1", size: "4x6" }]);
      return new Response(JSON.stringify({ key: body.out_key }), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await withTenant(shop.id, (tx) => binLabels(tx, ctx, { binIds: [bin.id] }));
    expect(res.key.startsWith(`${shop.id}/labels/`)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("reprintReasonsByWeek", () => {
  it("groups counts by week and reason, excluding cancelled", async () => {
    const shop = await createCompany();
    const ctx = tenantContext(shop.id, null, "owner");
    const connection = await withSystem(async (tx) => {
      const [row] = await tx
        .insert(channelConnections)
        .values({
          companyId: shop.id,
          channel: "csv",
          name: "csv",
          status: "csv_only",
          mode: "csv",
        })
        .returning();
      return row;
    });
    if (!connection) throw new Error("connection insert failed");
    const { items } = await createOrder(shop.id, connection.id, { units: 3 });
    const [item0, item1, item2] = items;
    if (!item0 || !item1 || !item2) throw new Error("order items insert failed");

    const week1 = new Date("2026-06-01T12:00:00Z"); // a Monday
    const week2 = new Date("2026-06-08T12:00:00Z");
    await withSystem((tx) =>
      tx.insert(reprints).values([
        {
          companyId: shop.id,
          orderItemId: item0.id,
          reason: "misprint",
          requestedAt: week1,
        },
        {
          companyId: shop.id,
          orderItemId: item1.id,
          reason: "peel",
          requestedAt: week1,
        },
        {
          companyId: shop.id,
          orderItemId: item2.id,
          reason: "misprint",
          requestedAt: week2,
          status: "cancelled",
        },
      ]),
    );

    const res = await withTenant(shop.id, (tx) =>
      reprintReasonsByWeek(tx, ctx, {
        from: new Date("2026-05-25T00:00:00Z").toISOString(),
        to: new Date("2026-06-15T00:00:00Z").toISOString(),
      }),
    );
    expect(res.weeks).toHaveLength(1);
    expect(res.weeks[0]?.total).toBe(2);
    expect(res.weeks[0]?.byReason).toEqual({ misprint: 1, peel: 1 });
  });
});
