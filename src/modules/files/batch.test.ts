import { beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "../../db/client";
import { gangSheetBatches, gangSheets, vendorAccess } from "../../db/schema";
import { objectKey, putObject } from "../../lib/s3";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { downloadUrl, downloadUrls } from "./service";

/*
 * T-37-5 (B-362): `files.downloadUrls` shares its per-key rules with `files.downloadUrl`. The
 * s3 module is wrapped so the tests can count object HEADs and their concurrency; every call
 * still reaches the real MinIO.
 */
const probe = vi.hoisted(() => ({ heads: [] as string[], inflight: 0, peak: 0, fail: "" }));
vi.mock("../../lib/s3", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/s3")>();
  return {
    ...real,
    headObject: async (key: string) => {
      probe.heads.push(key);
      if (key === probe.fail) throw new Error("storage down");
      probe.inflight++;
      probe.peak = Math.max(probe.peak, probe.inflight);
      try {
        await new Promise((r) => setTimeout(r, 15));
        return await real.headObject(key);
      } finally {
        probe.inflight--;
      }
    },
  };
});

describe("downloadUrls", () => {
  let a: string;
  let b: string;
  let office: ReturnType<typeof tenantContext>;
  let presser: ReturnType<typeof tenantContext>;
  let artwork: string;
  let preview: string;
  let label: string;
  let foreign: string;
  const missing = () => objectKey(a, "artwork", "png");

  beforeAll(async () => {
    a = (await createCompany()).id;
    b = (await createCompany()).id;
    office = tenantContext(a, (await createUser(a, "office")).id, "office");
    presser = tenantContext(a, (await createUser(a, "presser")).id, "presser");
    artwork = await putObject(objectKey(a, "artwork", "png"), "png", "image/png");
    preview = await putObject(objectKey(a, "mockup", "png"), "png", "image/png");
    label = await putObject(objectKey(a, "label", "pdf"), "%PDF", "application/pdf");
    foreign = await putObject(objectKey(b, "artwork", "png"), "png", "image/png");
  });

  it("matches the single call per key, in input order, with duplicates and partial nulls", async () => {
    const keys = [artwork, label, foreign, missing(), `${a}/../${foreign}`, preview, artwork];
    const { items } = await downloadUrls(presser, { fileKeys: keys, disposition: "inline" });
    expect(items.map((i) => i.fileKey)).toEqual(keys);
    expect(items.map((i) => i.download === null)).toEqual([
      false, // artwork
      true, // label: presser lacks shipping.read
      true, // other company
      true, // missing object
      true, // unsafe key
      false, // mockup
      false, // duplicate artwork
    ]);
    const single = await withTenant(a, (tx) =>
      downloadUrl(tx, presser, { fileKey: artwork, disposition: "inline" }),
    );
    expect(items[0]?.download).toMatchObject({
      fileKey: artwork,
      contentType: single.contentType,
      sizeBytes: single.sizeBytes,
    });
    expect(new URL(items[0]?.download?.url ?? "").searchParams.get("X-Amz-Expires")).toBe("900");
    const res = await fetch(items[0]?.download?.url ?? "");
    expect(res.status).toBe(200);
  });

  it("office reads the label key a presser cannot", async () => {
    const { items } = await downloadUrls(office, { fileKeys: [label], disposition: "inline" });
    expect(items[0]?.download?.fileKey).toBe(label);
  });

  it("forces an SVG to attachment like the single call", async () => {
    const svg = await putObject(objectKey(a, "design", "svg"), "<svg/>", "image/svg+xml");
    const { items } = await downloadUrls(office, { fileKeys: [svg], disposition: "inline" });
    const d = new URL(items[0]?.download?.url ?? "").searchParams.get(
      "response-content-disposition",
    );
    expect(d).toMatch(/^attachment;/);
  });

  it("another company's key looks exactly like a key that does not exist, and is never looked up", async () => {
    probe.heads.length = 0;
    const ghost = objectKey(b, "artwork", "png"); // company B, no object
    const { items } = await downloadUrls(presser, {
      fileKeys: [foreign, ghost, `${b}/label/x.pdf`],
      disposition: "inline",
    });
    expect(items.map((i) => i.download)).toEqual([null, null, null]);
    expect(probe.heads).toEqual([]);
    // And an own key that does not exist is null as well (same shape).
    const own = await downloadUrls(presser, { fileKeys: [missing()], disposition: "inline" });
    expect(own.items[0]?.download).toBeNull();
  });

  it("caps concurrent object HEADs", async () => {
    const many = await Promise.all(
      Array.from({ length: 20 }, () => putObject(objectKey(a, "artwork", "png"), "x", "image/png")),
    );
    probe.heads.length = 0;
    probe.peak = 0;
    const { items } = await downloadUrls(office, { fileKeys: many, disposition: "inline" });
    expect(items.every((i) => i.download)).toBe(true);
    expect(probe.heads).toHaveLength(20);
    expect(probe.peak).toBeLessThanOrEqual(8);
    expect(probe.peak).toBeGreaterThan(1);
  });

  it("a storage failure other than not-found fails the whole call", async () => {
    probe.fail = preview;
    try {
      await expect(
        downloadUrls(office, { fileKeys: [artwork, preview], disposition: "inline" }),
      ).rejects.toThrow("storage down");
    } finally {
      probe.fail = "";
    }
  });

  it("a vendor reads only keys of sheets shared with it, with one sheet query", async () => {
    const vendor = (await createCompany({ type: "vendor" })).id;
    const vctx = tenantContext(vendor, (await createUser(vendor, "vendor")).id, "vendor", "vendor");
    const sharedPng = await putObject(objectKey(a, "sheets", "png"), "p", "image/png");
    const sharedPdf = await putObject(objectKey(a, "sheets", "pdf"), "p", "application/pdf");
    const hiddenPng = await putObject(objectKey(a, "sheets", "png"), "p", "image/png");
    await withTenant(a, async (tx) => {
      const [batch] = await tx
        .insert(gangSheetBatches)
        .values({ companyId: a, name: "Batch" })
        .returning();
      if (!batch) throw new Error("batch");
      const [shared] = await tx
        .insert(gangSheets)
        .values({
          companyId: a,
          batchId: batch.id,
          name: "s",
          status: "sent",
          pngKey: sharedPng,
          pdfKey: sharedPdf,
        })
        .returning();
      await tx
        .insert(gangSheets)
        .values({ companyId: a, batchId: batch.id, name: "h", status: "ready", pngKey: hiddenPng });
      if (!shared) throw new Error("sheet");
      await tx
        .insert(vendorAccess)
        .values({ companyId: a, vendorCompanyId: vendor, gangSheetId: shared.id });
    });
    const keys = [sharedPng, hiddenPng, sharedPdf, artwork];
    const { items } = await downloadUrls(vctx, { fileKeys: keys, disposition: "inline" });
    expect(items.map((i) => i.download === null)).toEqual([false, true, false, true]);
    for (const [i, k] of keys.entries()) {
      const single = await downloadUrl(null as never, vctx, {
        fileKey: k,
        disposition: "inline",
      }).then(
        () => true,
        () => false,
      );
      expect(single, k).toBe(items[i]?.download !== null);
    }
  });
});
