import { eq, inArray } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  designFiles,
  designs,
  files,
  gangSheetBatches,
  gangSheets,
  itemArtwork,
  listingDrafts,
  orderItems,
  orders,
  transfers,
} from "../../db/schema";
import { runJobInline } from "../../lib/queues";
import { objectKey, putObject } from "../../lib/s3";
import { createCompany, createConnection, createOrder } from "../../test/fixtures";
import { purgeBuyerPii, purgePiiObjects } from "../orders/jobs";
import { createNameTemplate, exists, readBack, seedItemArt } from "./buyer-text.fixtures";
import { privacyRetentionSweepJob } from "./jobs";
import {
  ORPHAN_MIN_AGE_MS,
  purgeSheetFiles,
  REF_CHUNK,
  referencedKeys,
  reportSheetsWaitingOverCap,
  SHEET_FILES_PURGE_STATES,
  SHEET_WAITING_CAP_DAYS,
  storageKeyColumns,
} from "./print-files";

/* Real MinIO, recording every delete, with a switch to make chosen keys fail to delete. */
const s3 = vi.hoisted(() => ({ failing: new Set<string>(), deleted: [] as string[] }));
vi.mock("../../lib/s3", async (orig) => {
  const actual = await orig<typeof import("../../lib/s3")>();
  return {
    ...actual,
    deleteObject: async (key: string) => {
      s3.deleted.push(key);
      if (s3.failing.has(key)) throw new Error("storage unavailable");
      return actual.deleteObject(key);
    },
  };
});

/* Warnings, captured with their data (the real logger still writes). */
const logs = vi.hoisted(() => ({ warn: [] as { msg: string; data?: Record<string, unknown> }[] }));
vi.mock("../../lib/log", async (orig) => {
  const actual = await orig<typeof import("../../lib/log")>();
  return {
    ...actual,
    logger: (scope: string) => {
      const real = actual.logger(scope);
      return {
        ...real,
        warn: (msg: string, data?: Record<string, unknown>) => {
          logs.warn.push({ msg, data });
          real.warn(msg, data);
        },
      };
    },
  };
});

const DAY = 86400_000;
/** "Now" for the orphan sweep: every object put during the test is older than 2 days then. */
const later = () => new Date(Date.now() + ORPHAN_MIN_AGE_MS + DAY);
type SheetStatus = (typeof gangSheets.$inferInsert)["status"] & string;

const png = (c: string, kind: string) => putObject(objectKey(c, kind, "png"), "x", "image/png");

async function shop() {
  const c = (await createCompany()).id;
  const conn = await createConnection(c);
  return { c, conn: conn.id };
}

/** A sheet with real PNG, PDF and preview objects (and a `files` row), holding these units. */
async function makeSheet(
  c: string,
  status: SheetStatus,
  units: { itemId: string; scrapped?: boolean; isReprint?: boolean }[],
) {
  const pngKey = await png(c, "sheet");
  const pdfKey = await putObject(objectKey(c, "sheet", "pdf"), "%PDF", "application/pdf");
  const previewKey = await png(c, "preview");
  const sheet = await withSystem(async (tx) => {
    const [batch] = await tx
      .insert(gangSheetBatches)
      .values({ companyId: c, name: "B" })
      .returning();
    const [row] = await tx
      .insert(gangSheets)
      .values({
        companyId: c,
        batchId: batch?.id as string,
        name: `S-${crypto.randomUUID().slice(0, 8)}`,
        status,
        pngKey,
        pdfKey,
        previewKey,
        transferCount: units.length,
        costCents: 1234,
      })
      .returning();
    if (!row) throw new Error("sheet insert failed");
    for (const u of units)
      await tx.insert(transfers).values({
        companyId: c,
        gangSheetId: row.id,
        orderItemId: u.itemId,
        widthIn: 10,
        heightIn: 12,
        scrapped: u.scrapped ?? false,
        isReprint: u.isReprint ?? false,
        status: u.scrapped ? "scrap" : "placed",
      });
    await tx.insert(files).values({ companyId: c, key: pngKey, kind: "sheet", status: "ready" });
    return row;
  });
  return { id: sheet.id, keys: [pngKey, pdfKey, previewKey] };
}

/** A unit whose artwork an earlier night (any 0027 clock) already purged. */
async function purgedUnit(c: string, conn: string, state: "delivered" | "ready" = "delivered") {
  const { items } = await createOrder(c, conn, { state });
  const item = items[0];
  if (!item) throw new Error("no item");
  await withSystem((tx) =>
    tx.update(orderItems).set({ artworkStatus: "purged" }).where(eq(orderItems.id, item.id)),
  );
  return item.id;
}

async function liveUnit(c: string, conn: string) {
  const { items } = await createOrder(c, conn, { state: "ready" });
  if (!items[0]) throw new Error("no item");
  return items[0].id;
}

const sheetRow = async (c: string, id: string) =>
  (await withTenant(c, (tx) => tx.select().from(gangSheets).where(eq(gangSheets.id, id))))[0];

async function allExist(keys: string[]) {
  return (await Promise.all(keys.map(exists))).every(Boolean);
}
async function noneExist(keys: string[]) {
  return (await Promise.all(keys.map(exists))).every((e) => !e);
}

describe("gang sheet print files follow the unit clocks (decision 0031)", () => {
  it("deletes a received sheet's files the night its unit is purged; the sheet row stays", async () => {
    const { c, conn } = await shop();
    const tpl = await createNameTemplate(c);
    const { order, items } = await createOrder(c, conn, { state: "delivered" });
    const item = items[0];
    if (!item) throw new Error("no item");
    await seedItemArt(c, item.id, tpl.id);
    const other = await liveUnit(c, conn);
    const sheet = await makeSheet(c, "received", [{ itemId: item.id }, { itemId: other }]);
    await withSystem((tx) =>
      tx
        .update(orders)
        .set({
          shippedAt: new Date(Date.now() - 40 * DAY),
          deliveredAt: new Date(Date.now() - 35 * DAY),
        })
        .where(eq(orders.id, order.id)),
    );

    const res = await purgeBuyerPii();

    expect((await readBack(c, order.id, item.id)).item?.artworkStatus).toBe("purged");
    expect(res.sheetFilesPurged).toBeGreaterThanOrEqual(1);
    expect(await noneExist(sheet.keys)).toBe(true);
    const row = await sheetRow(c, sheet.id);
    expect(row).toMatchObject({
      pngKey: null,
      pdfKey: null,
      previewKey: null,
      status: "received",
      transferCount: 2,
      costCents: 1234,
    });
    const left = await withTenant(c, async (tx) => ({
      files: await tx.select().from(files).where(inArray(files.key, sheet.keys)),
      transfers: await tx.select().from(transfers).where(eq(transfers.gangSheetId, sheet.id)),
    }));
    expect(left.files).toHaveLength(0);
    expect(left.transfers).toHaveLength(2);
  });

  it("finds sheets through every transfer of the unit, scrapped and reprint sheets included", async () => {
    const { c, conn } = await shop();
    const unit = await purgedUnit(c, conn);
    const first = await makeSheet(c, "printed", [{ itemId: unit, scrapped: true }]);
    const reprint = await makeSheet(c, "shipped", [{ itemId: unit, isReprint: true }]);
    // order_items.transfer_id points only at the latest transfer (the reprint).
    await withSystem(async (tx) => {
      const [t] = await tx
        .select({ id: transfers.id })
        .from(transfers)
        .where(eq(transfers.gangSheetId, reprint.id));
      await tx.update(orderItems).set({ transferId: t?.id }).where(eq(orderItems.id, unit));
    });

    await purgeBuyerPii();

    for (const s of [first, reprint]) {
      expect(await noneExist(s.keys)).toBe(true);
      expect((await sheetRow(c, s.id))?.pngKey).toBeNull();
    }
  });

  it("purges every state in SHEET_FILES_PURGE_STATES and keeps sheets still being made", async () => {
    const { c, conn } = await shop();
    const unit = await purgedUnit(c, conn);
    const due = await Promise.all(
      SHEET_FILES_PURGE_STATES.map((s) => makeSheet(c, s, [{ itemId: unit }])),
    );
    const waitingStates = ["building", "ready", "printing", "sent", "acknowledged"] as const;
    const waiting = await Promise.all(
      waitingStates.map((s) => makeSheet(c, s, [{ itemId: unit }])),
    );

    const res = await purgeBuyerPii();

    for (const s of due) expect(await noneExist(s.keys)).toBe(true);
    for (const s of waiting) {
      expect(await allExist(s.keys)).toBe(true);
      expect((await sheetRow(c, s.id))?.pngKey).not.toBeNull();
    }
    expect(res.sheetsWaiting).toBeGreaterThanOrEqual(waiting.length);
    expect(res.oldestSheetWaitingDays).not.toBeNull();

    // The first night after a waiting sheet leaves production, its files go.
    const sent = waiting[3];
    if (!sent) throw new Error("no sheet");
    await withSystem((tx) =>
      tx.update(gangSheets).set({ status: "printed" }).where(eq(gangSheets.id, sent.id)),
    );
    await purgeBuyerPii();
    expect(await noneExist(sent.keys)).toBe(true);
    expect(await allExist(waiting[1]?.keys ?? [])).toBe(true);
  });

  it("never touches a sheet without a purged unit", async () => {
    const { c, conn } = await shop();
    const tpl = await createNameTemplate(c);
    const { items } = await createOrder(c, conn, { state: "delivered" });
    const item = items[0];
    if (!item) throw new Error("no item");
    await seedItemArt(c, item.id, tpl.id); // personalized, but its clock hasn't run
    const plain = await liveUnit(c, conn);
    const a = await makeSheet(c, "received", [{ itemId: item.id }]);
    const b = await makeSheet(c, "cancelled", [{ itemId: plain }]);
    // The same company has a sheet that is due, so its run does happen.
    const due = await makeSheet(c, "received", [{ itemId: await purgedUnit(c, conn) }]);

    await purgeBuyerPii();

    expect(await noneExist(due.keys)).toBe(true);
    for (const s of [a, b]) {
      expect(await allExist(s.keys)).toBe(true);
      expect((await sheetRow(c, s.id))?.pdfKey).not.toBeNull();
    }
  });

  it("storage first: a failed delete keeps all three keys for the next night; a rerun changes nothing", async () => {
    const { c, conn } = await shop();
    const unit = await purgedUnit(c, conn);
    const sheet = await makeSheet(c, "received", [{ itemId: unit }]);
    s3.failing.add(sheet.keys[1] as string);
    try {
      const res = await purgeBuyerPii();
      expect(res.failedFiles).toBeGreaterThanOrEqual(1);
      expect((await sheetRow(c, sheet.id))?.pngKey).toBe(sheet.keys[0]);
      expect((await sheetRow(c, sheet.id))?.pdfKey).toBe(sheet.keys[1]);
      expect((await sheetRow(c, sheet.id))?.previewKey).toBe(sheet.keys[2]);
    } finally {
      s3.failing.clear();
    }

    await purgeBuyerPii();
    expect(await noneExist(sheet.keys)).toBe(true);
    const cleared = await sheetRow(c, sheet.id);
    expect(cleared?.pngKey).toBeNull();

    const again = await purgeBuyerPii();
    expect(again.sheetFilesPurged).toBe(0);
    expect((await sheetRow(c, sheet.id))?.updatedAt).toEqual(cleared?.updatedAt);
  });

  it("company A's run never touches company B's sheet files", async () => {
    const a = await shop();
    const b = await shop();
    const aSheet = await makeSheet(a.c, "received", [{ itemId: await purgedUnit(a.c, a.conn) }]);
    const bSheet = await makeSheet(b.c, "received", [{ itemId: await purgedUnit(b.c, b.conn) }]);

    const res = await purgeSheetFiles(a.c);

    expect(res.sheetFilesPurged).toBe(1);
    expect(await noneExist(aSheet.keys)).toBe(true);
    expect(await allExist(bSheet.keys)).toBe(true);
    expect((await sheetRow(b.c, bSheet.id))?.pngKey).toBe(bSheet.keys[0]);
  });
});

describe("sheet key backstop and failed-delete warning (B-310)", () => {
  it("a sheet key outside the company prefix is skipped: no delete call, the other company's object stays", async () => {
    const a = await shop();
    const b = await shop();
    const sheet = await makeSheet(a.c, "received", [{ itemId: await purgedUnit(a.c, a.conn) }]);
    const foreign = await png(b.c, "sheet");
    await withSystem(async (tx) => {
      await tx.update(gangSheets).set({ pngKey: foreign }).where(eq(gangSheets.id, sheet.id));
      await tx
        .insert(files)
        .values({ companyId: b.c, key: foreign, kind: "sheet", status: "ready" });
    });
    s3.deleted.length = 0;

    const res = await purgeSheetFiles(a.c);

    expect(res.sheetFilesPurged).toBe(1);
    expect(s3.deleted).not.toContain(foreign);
    expect(s3.deleted.sort()).toEqual([sheet.keys[1], sheet.keys[2]].sort());
    expect(await exists(foreign)).toBe(true);
    const bRow = await withTenant(b.c, (tx) =>
      tx.select().from(files).where(eq(files.key, foreign)),
    );
    expect(bRow).toHaveLength(1);
  });

  it("a failed sheet file delete logs a warning with the sheet id", async () => {
    const { c, conn } = await shop();
    const sheet = await makeSheet(c, "received", [{ itemId: await purgedUnit(c, conn) }]);
    s3.failing.add(sheet.keys[0] as string);
    logs.warn.length = 0;
    try {
      const res = await purgeSheetFiles(c);
      expect(res.failedSheets).toBe(1);
    } finally {
      s3.failing.clear();
    }
    const warned = logs.warn.filter((l) => l.data?.companyId === c);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.data).toMatchObject({ companyId: c, sheetId: sheet.id });
  });
});

describe("sheets waiting past 14 days with a purged unit are reported, never changed (decision 0033)", () => {
  const CAP = SHEET_WAITING_CAP_DAYS * DAY;
  const backdate = (id: string, createdAt: Date) =>
    withSystem((tx) => tx.update(gangSheets).set({ createdAt }).where(eq(gangSheets.id, id)));

  it("counts ready, sent and acknowledged sheets past the cap with a warning each; files and states stay", async () => {
    const { c, conn } = await shop();
    const now = new Date();
    const over = new Date(now.getTime() - CAP - 1000);
    const due: { id: string; keys: string[]; status: SheetStatus }[] = [];
    for (const status of ["ready", "sent", "acknowledged"] as const) {
      const s = await makeSheet(c, status, [{ itemId: await purgedUnit(c, conn) }]);
      await backdate(s.id, over);
      due.push({ ...s, status });
    }
    // Not counted: exactly 14 days old, a waiting state outside the cap, no purged unit.
    const atCap = await makeSheet(c, "ready", [{ itemId: await purgedUnit(c, conn) }]);
    await backdate(atCap.id, new Date(now.getTime() - CAP));
    const printing = await makeSheet(c, "printing", [{ itemId: await purgedUnit(c, conn) }]);
    await backdate(printing.id, over);
    const live = await makeSheet(c, "ready", [{ itemId: await liveUnit(c, conn) }]);
    await backdate(live.id, over);
    const before = await withTenant(c, (tx) =>
      tx.select().from(gangSheets).where(eq(gangSheets.companyId, c)),
    );
    logs.warn.length = 0;
    s3.deleted.length = 0;

    for (let run = 0; run < 2; run++) {
      const res = await reportSheetsWaitingOverCap(now, [c]);
      expect(res).toEqual({ sheetsWaitingOverCap: 3, failedCompanies: 0 });
    }

    const warned = logs.warn.filter((l) => l.data?.companyId === c).map((l) => l.data?.sheetId);
    expect(warned.sort()).toEqual([...due, ...due].map((d) => d.id).sort());
    expect(s3.deleted).toEqual([]);
    for (const d of due) expect(await allExist(d.keys)).toBe(true);
    const after = await withTenant(c, (tx) =>
      tx.select().from(gangSheets).where(eq(gangSheets.companyId, c)),
    );
    const byId = (rows: typeof after) => [...rows].sort((x, y) => x.id.localeCompare(y.id));
    expect(byId(after)).toEqual(byId(before));
  });

  it("company A's report never counts or logs company B's sheets", async () => {
    const a = await shop();
    const b = await shop();
    const over = new Date(Date.now() - CAP - DAY);
    const aSheet = await makeSheet(a.c, "ready", [{ itemId: await purgedUnit(a.c, a.conn) }]);
    const bSheet = await makeSheet(b.c, "sent", [{ itemId: await purgedUnit(b.c, b.conn) }]);
    await backdate(aSheet.id, over);
    await backdate(bSheet.id, over);
    logs.warn.length = 0;

    const res = await reportSheetsWaitingOverCap(new Date(), [a.c]);

    expect(res.sheetsWaitingOverCap).toBe(1);
    expect(logs.warn.map((l) => l.data?.sheetId)).toEqual([aSheet.id]);
    expect((await sheetRow(b.c, bSheet.id))?.status).toBe("sent");
  });

  it("runs in the daily privacy.retentionSweep job, the same count each night, nothing changed", async () => {
    const { c, conn } = await shop();
    const s = await makeSheet(c, "ready", [{ itemId: await purgedUnit(c, conn) }]);
    await backdate(s.id, new Date(Date.now() - CAP - DAY));
    for (let run = 0; run < 2; run++) {
      const res = (await runJobInline(privacyRetentionSweepJob, {})) as {
        sheetsWaitingOverCap: number;
      };
      expect(res.sheetsWaitingOverCap).toBeGreaterThanOrEqual(1);
      expect(await allExist(s.keys)).toBe(true);
      expect((await sheetRow(c, s.id))?.status).toBe("ready");
    }
  });
});

describe("orphan renders and sheet files (decision 0031)", () => {
  it("knows every column that points at a stored object", () => {
    const cols = new Set(storageKeyColumns().map((k) => `${k.table}.${k.column}`));
    for (const want of [
      "item_artwork.fileKey",
      "item_artwork.previewKey",
      "order_items.artworkKey",
      "order_items.artworkPreviewKey",
      "gang_sheets.pngKey",
      "gang_sheets.pdfKey",
      "gang_sheets.previewKey",
      "design_files.fileKey",
      "design_files.previewKey",
      "files.key",
      "listing_drafts.mockupKeys",
      "personalization_templates.backgroundKey",
    ])
      expect(cols, want).toContain(want);
  });

  it("deletes unreferenced artwork, sheet and preview objects older than 2 days; keeps young ones and catalog previews", async () => {
    const { c } = await shop();
    const orphans = [await png(c, "artwork"), await png(c, "sheet"), await png(c, "preview")];
    const catalog = await putObject(
      `${c}/preview/design/${crypto.randomUUID()}.png`,
      "x",
      "image/png",
    );

    const young = await purgePiiObjects(new Date(), [c]);
    expect(young.orphanRendersDeleted).toBe(0);
    expect(await allExist(orphans)).toBe(true);

    const res = await purgePiiObjects(later(), [c]);
    expect(res.orphanRendersDeleted).toBe(3);
    expect(await noneExist(orphans)).toBe(true);
    expect(await exists(catalog)).toBe(true);

    const again = await purgePiiObjects(later(), [c]);
    expect(again.orphanRendersDeleted).toBe(0);
  });

  type Ref = { name: string; point: (c: string, conn: string, key: string) => Promise<unknown> };
  const setItem = (c: string, conn: string, set: Partial<typeof orderItems.$inferInsert>) =>
    liveUnit(c, conn).then((id) =>
      withSystem((tx) => tx.update(orderItems).set(set).where(eq(orderItems.id, id))),
    );
  const setArt = async (c: string, conn: string, set: Partial<typeof itemArtwork.$inferInsert>) => {
    const id = await liveUnit(c, conn);
    const tpl = await createNameTemplate(c);
    await withSystem((tx) =>
      tx.insert(itemArtwork).values({ companyId: c, orderItemId: id, templateId: tpl.id, ...set }),
    );
  };
  const sheetWith = (c: string, set: Partial<typeof gangSheets.$inferInsert>) =>
    withSystem(async (tx) => {
      const [batch] = await tx
        .insert(gangSheetBatches)
        .values({ companyId: c, name: "B" })
        .returning();
      await tx.insert(gangSheets).values({
        companyId: c,
        batchId: batch?.id as string,
        name: `S-${crypto.randomUUID().slice(0, 8)}`,
        status: "ready",
        ...set,
      });
    });
  const designWith = (c: string, set: { fileKey?: string; previewKey?: string }) =>
    withSystem(async (tx) => {
      const [d] = await tx
        .insert(designs)
        .values({ companyId: c, code: `D-${crypto.randomUUID().slice(0, 6)}`, name: "Cactus" })
        .returning();
      await tx.insert(designFiles).values({
        companyId: c,
        designId: d?.id as string,
        fileKey: set.fileKey ?? `${c}/design/x.png`,
        previewKey: set.previewKey ?? null,
        widthIn: 10,
        heightIn: 12,
      });
      return d?.id as string;
    });
  const refs: Ref[] = [
    { name: "item_artwork.file_key", point: (c, n, k) => setArt(c, n, { fileKey: k }) },
    { name: "item_artwork.preview_key", point: (c, n, k) => setArt(c, n, { previewKey: k }) },
    { name: "item_artwork.values", point: (c, n, k) => setArt(c, n, { values: { photo: k } }) },
    { name: "order_items.artwork_key", point: (c, n, k) => setItem(c, n, { artworkKey: k }) },
    {
      name: "order_items.artwork_preview_key",
      point: (c, n, k) => setItem(c, n, { artworkPreviewKey: k }),
    },
    {
      name: "order_items.personalization",
      point: (c, n, k) =>
        setItem(c, n, { personalization: [{ question: "Photo", answer: null, fileUrl: k }] }),
    },
    { name: "gang_sheets.png_key", point: (c, _n, k) => sheetWith(c, { pngKey: k }) },
    { name: "gang_sheets.pdf_key", point: (c, _n, k) => sheetWith(c, { pdfKey: k }) },
    { name: "gang_sheets.preview_key", point: (c, _n, k) => sheetWith(c, { previewKey: k }) },
    { name: "design_files.file_key", point: (c, _n, k) => designWith(c, { fileKey: k }) },
    { name: "design_files.preview_key", point: (c, _n, k) => designWith(c, { previewKey: k }) },
    {
      name: "files.key",
      point: (c, _n, k) =>
        withSystem((tx) =>
          tx.insert(files).values({ companyId: c, key: k, kind: "artwork", status: "ready" }),
        ),
    },
    {
      name: "listing_drafts.mockup_keys",
      point: async (c, _n, k) => {
        const designId = await designWith(c, {});
        await withSystem((tx) =>
          tx
            .insert(listingDrafts)
            .values({ companyId: c, designId, channel: "etsy", mockupKeys: [k] }),
        );
      },
    },
  ];

  it.each(refs)("keeps an old object that $name points at", async ({ point }) => {
    const { c, conn } = await shop();
    const kept = await png(c, "artwork");
    const gone = await png(c, "artwork");
    await point(c, conn, kept);

    const res = await purgePiiObjects(later(), [c]);

    expect(await exists(kept)).toBe(true);
    expect(await exists(gone)).toBe(false);
    expect(res.orphanRendersDeleted).toBe(1);
  });

  it("floor correctness: a ready sheet's current files and a unit's live render survive the sweep", async () => {
    const { c, conn } = await shop();
    const tpl = await createNameTemplate(c);
    const unit = await liveUnit(c, conn);
    const art = await seedItemArt(c, unit, tpl.id);
    const ready = await makeSheet(c, "ready", [{ itemId: unit }]);
    await withSystem((tx) => tx.delete(files).where(inArray(files.key, ready.keys)));

    await purgePiiObjects(later(), [c]);

    expect(await allExist(ready.keys)).toBe(true);
    expect(await allExist([art.fileKey, art.previewKey])).toBe(true);
  });

  it("checks references in chunks of at most 1,000 keys", async () => {
    const { c } = await shop();
    await expect(
      withTenant(c, (tx) =>
        referencedKeys(
          tx,
          Array.from({ length: REF_CHUNK + 1 }, (_, i) => `${c}/artwork/${i}.png`),
        ),
      ),
    ).rejects.toThrow(/at most 1000/);

    const keys: string[] = [];
    for (let i = 0; i < REF_CHUNK + 5; i += 50)
      keys.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(50, REF_CHUNK + 5 - i) }, () => png(c, "preview")),
        )),
      );
    const kept = keys.slice().sort()[REF_CHUNK + 2] as string; // lands in the second chunk
    await sheetWith(c, { previewKey: kept });

    const res = await purgePiiObjects(later(), [c]);

    expect(res.orphanRendersDeleted).toBe(REF_CHUNK + 4);
    expect(await exists(kept)).toBe(true);
  });
});

describe("shared buyer photo (S-59)", () => {
  it("keeps a photo two units use until the last of them is purged", async () => {
    const { c, conn } = await shop();
    const tpl = await createNameTemplate(c);
    const first = await createOrder(c, conn, { state: "delivered" });
    const second = await createOrder(c, conn, { state: "delivered" });
    const a = first.items[0];
    const b = second.items[0];
    if (!a || !b) throw new Error("no item");
    const art = await seedItemArt(c, a.id, tpl.id);
    await seedItemArt(c, b.id, tpl.id);
    await withSystem((tx) =>
      tx
        .update(itemArtwork)
        .set({ values: { name: "Second", photo: art.photoKey } })
        .where(eq(itemArtwork.orderItemId, b.id)),
    );
    const age = (orderId: string) =>
      withSystem((tx) =>
        tx
          .update(orders)
          .set({
            shippedAt: new Date(Date.now() - 40 * DAY),
            deliveredAt: new Date(Date.now() - 35 * DAY),
          })
          .where(eq(orders.id, orderId)),
      );

    await age(first.order.id);
    const res = await purgeBuyerPii();
    expect(res.sharedPhotosKept).toBe(1);
    expect((await readBack(c, first.order.id, a.id)).art?.status).toBe("purged");
    expect(await exists(art.photoKey)).toBe(true);
    expect(await exists(art.fileKey)).toBe(false);

    await age(second.order.id);
    const last = await purgeBuyerPii();
    expect(last.sharedPhotosKept).toBe(0);
    expect(await exists(art.photoKey)).toBe(false);
  });
});
