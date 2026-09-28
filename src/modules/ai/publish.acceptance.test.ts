import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  auditLog,
  blankVariants,
  channelConnections,
  companies,
  designs,
  listingDrafts,
  products,
} from "../../db/schema";
import { parseCsvObjects } from "../../lib/csv";
import { getObject, listObjects } from "../../lib/s3";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import * as svc from "./service";

/*
 * T-20-3 (B-71) AC2, publishDraft: today no channel has a live listing API, so "publishing" is
 * one bulk-upload CSV written to the bucket under a key derived from the draft id. Publishing
 * twice (or twice at once) must leave one file at one key and the draft still approved, with no
 * second export row or a stray file. If a live publish API lands, this file is where the
 * "one listing created per draft" guard gets its test.
 */

describe("T-20-3 publishDraft is repeatable", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let designId: string;
  let productId: string;
  let connectionId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    await withSystem(async (tx) => {
      await tx
        .update(companies)
        .set({ settings: { productionPartner: { name: "Cactus Print Co", etsyPartnerId: null } } })
        .where(eq(companies.id, companyId));
      const [d] = await tx
        .insert(designs)
        .values({ companyId, code: "D-T203", name: "Saguaro Sunset", tags: ["cactus", "desert"] })
        .returning();
      designId = d?.id as string;
      const [p] = await tx
        .insert(products)
        .values({
          companyId,
          designId,
          brand: "Gildan",
          styleCode: "G64000",
          name: "Saguaro Tee",
          allowedColorCodes: ["BLK"],
          allowedSizeCodes: ["S", "M"],
        })
        .returning();
      productId = p?.id as string;
      await tx.insert(blankVariants).values(
        ["S", "M"].map((size) => ({
          companyId,
          brand: "Gildan",
          style: "64000",
          styleCode: "G64000",
          color: "Black",
          colorCode: "BLK",
          size,
          sizeCode: size,
          sku: `T203-PUB-BLK-${size}`,
        })),
      );
      const [conn] = await tx
        .insert(channelConnections)
        .values({ companyId, channel: "etsy", name: "Etsy CSV", mode: "csv", provider: "mock" })
        .returning();
      connectionId = conn?.id as string;
    });
  });

  async function approvedDraft() {
    const enq: string[] = [];
    svc.setGenerationEnqueuer(async (input) => {
      enq.push(...input.draftIds);
    });
    const { jobId, drafts } = await withTenant(companyId, (tx) =>
      svc.createDrafts(tx, ctx, { designId, productId, channels: ["etsy"] }),
    );
    await svc.runGenerationJob({ companyId, jobId, draftIds: enq, userId: ctx.userId });
    return withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, drafts[0]?.id as string));
  }

  const draftRow = async (id: string) => {
    const [row] = await withSystem((tx) =>
      tx.select().from(listingDrafts).where(eq(listingDrafts.id, id)),
    );
    if (!row) throw new Error("draft missing");
    return row;
  };
  const exportAudits = (id: string) =>
    withSystem((tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, id))
        .then((rows) => rows.filter((r) => r.action === "listing_draft.export")),
    );

  it("publishing twice writes one file at one key and keeps the draft approved", async () => {
    const draft = await approvedDraft();
    const publish = () =>
      withTenant(companyId, (tx) => svc.publishDraft(tx, ctx, draft.id, connectionId));
    const first = await publish();
    const again = await publish();
    expect(first).toMatchObject({ status: "approved", pendingApproval: true });
    expect(again.publishedUrl).toBe(first.publishedUrl);
    const row = await draftRow(draft.id);
    const key = (row.publishedUrl as string).replace(/^s3:/, "");
    expect(key.startsWith(`${companyId}/`)).toBe(true);
    // One object for this draft: the key carries the draft id, so a repeat overwrites.
    const objects = await listObjects(`${companyId}/listing-export/`);
    expect(objects.filter((o) => o.key.includes(draft.id))).toHaveLength(1);
    const csv = (await getObject(key)).toString("utf8");
    expect(parseCsvObjects(csv).rows).toHaveLength(2); // one row per allowed SKU
    expect(csv).toMatch(/T203-PUB-BLK-S/);
    expect(await exportAudits(draft.id)).toHaveLength(2);
    expect(row).toMatchObject({ status: "approved", connectionId, error: null });
  });

  it("two concurrent publishes land on the same key and the draft is still approved", async () => {
    const draft = await approvedDraft();
    const publish = () =>
      withTenant(companyId, (tx) => svc.publishDraft(tx, ctx, draft.id, connectionId));
    const results = await Promise.allSettled([publish(), publish()]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results)
      if (r.status === "rejected") expect((r.reason as { code?: string }).code).toBe("CONFLICT");
    const urls = new Set(
      ok.map(
        (r) => (r as PromiseFulfilledResult<{ publishedUrl: string | null }>).value.publishedUrl,
      ),
    );
    expect(urls.size).toBe(1);
    const objects = await listObjects(`${companyId}/listing-export/`);
    expect(objects.filter((o) => o.key.includes(draft.id))).toHaveLength(1);
    expect((await draftRow(draft.id)).status).toBe("approved");
  });

  it("another company can't publish this draft and no file is written for it", async () => {
    const draft = await approvedDraft();
    const other = (await createCompany()).id;
    const otherCtx = tenantContext(other, (await createUser(other, "owner")).id, "owner");
    await expect(
      withTenant(other, (tx) => svc.publishDraft(tx, otherCtx, draft.id, connectionId)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listObjects(`${other}/`)).toHaveLength(0);
    expect((await draftRow(draft.id)).publishedUrl).toBeNull();
  });
});
