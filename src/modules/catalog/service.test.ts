import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withTenant } from "../../db/client";
import { designFiles, orderItems } from "../../db/schema";
import { headObject, putObject } from "../../lib/s3";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";

/*
 * T-P2-2 round 2: `renderDesignPreviews` now calls `imaging.preview` with `allowPlaceholder:
 * false` (it's the job's own function), so it no longer falls back to a placeholder when no real
 * imaging service answers — which is the normal case for a plain `pnpm test` run. Mock `preview`
 * here so these tests stay about tenant checks and idempotency, not about whether imaging happens
 * to be running; the real client's own behavior is covered by `imaging/client.test.ts` and
 * `jobs.imaging-down.test.ts`.
 */
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return {
    ...actual,
    imaging: {
      ...actual.imaging,
      preview: vi.fn(async (input: { out_key: string }) => ({
        out_key: input.out_key,
        width_px: 512,
        height_px: 512,
      })),
    },
  };
});

import * as svc from "./service";

/**
 * Worked example of the module test pattern: a company + user fixture, service calls inside
 * `withTenant`, and one router call through `call()` to prove the permission guard.
 */
describe("catalog service", () => {
  let companyId: string;
  let designerId: string;
  let ctx: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    designerId = (await createUser(companyId, "designer")).id;
    ctx = tenantContext(companyId, designerId, "designer");
  });

  const designInput = (code: string) => ({
    code,
    name: `Design ${code}`,
    tags: ["cactus", "sun"],
    placements: [
      {
        placement: "front" as const,
        fileKey: `${companyId}/design/x.png`,
        widthIn: 11,
        heightIn: 12,
      },
    ],
    personalizationTemplateId: null,
  });

  it("creates, lists, searches and archives designs", async () => {
    const created = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, ctx, designInput("D1")),
    );
    expect(created.code).toBe("D1");
    expect(created.placements).toHaveLength(1);
    expect(created.qaStatus).toBe("pending");
    expect(created.ordersLast30d).toBe(0);

    await withTenant(companyId, (tx) => svc.createDesign(tx, ctx, designInput("D2")));
    const page = await withTenant(companyId, (tx) => svc.listDesigns(tx, ctx, { limit: 1 }));
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await withTenant(companyId, (tx) =>
      svc.listDesigns(tx, ctx, { limit: 1, cursor: page.nextCursor ?? undefined }),
    );
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);

    const byTag = await withTenant(companyId, (tx) =>
      svc.listDesigns(tx, ctx, { limit: 50, tag: "cactus" }),
    );
    expect(byTag.items).toHaveLength(2);
    const bySearch = await withTenant(companyId, (tx) =>
      svc.listDesigns(tx, ctx, { limit: 50, search: "d2" }),
    );
    expect(bySearch.items.map((d) => d.code)).toEqual(["D2"]);

    const archived = await withTenant(companyId, (tx) =>
      svc.setDesignStatus(tx, ctx, created.id, "archived"),
    );
    expect(archived.status).toBe("archived");
    const active = await withTenant(companyId, (tx) => svc.listDesigns(tx, ctx, { limit: 50 }));
    expect(active.items.map((d) => d.code)).toEqual(["D2"]);
  });

  it("rejects duplicate design codes", async () => {
    await withTenant(companyId, (tx) => svc.createDesign(tx, ctx, designInput("DUP")));
    await expect(
      withTenant(companyId, (tx) => svc.createDesign(tx, ctx, designInput("DUP"))),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("bulk imports blanks idempotently and exposes facets", async () => {
    const row = (size: string, cost: number) => ({
      brand: "Gildan",
      style: "64000",
      styleCode: "G64000",
      styleName: "Softstyle",
      color: "Black",
      colorCode: "BLK",
      colorHex: "#111111",
      size,
      sizeCode: size,
      supplier: "ssactivewear" as const,
      supplierSku: `B0000${size}`,
      cost,
      weightOz: 5.5,
    });
    const first = await withTenant(companyId, (tx) =>
      svc.bulkImportBlanks(tx, ctx, { rows: [row("S", 300), row("M", 300)] }),
    );
    expect(first).toMatchObject({ created: 2, updated: 0, failed: 0 });
    const second = await withTenant(companyId, (tx) =>
      svc.bulkImportBlanks(tx, ctx, { rows: [row("S", 320), row("L", 300)] }),
    );
    expect(second).toMatchObject({ created: 1, updated: 1, failed: 0 });

    const blanks = await withTenant(companyId, (tx) =>
      svc.listBlanks(tx, ctx, { limit: 50, sizeCode: "S" }),
    );
    expect(blanks.items[0]?.cost).toBe(320);
    expect(blanks.items[0]?.id).toBeDefined();
    const facets = await withTenant(companyId, (tx) => svc.blankFacets(tx, ctx));
    expect(facets.brands).toEqual(["Gildan"]);
    expect(facets.sizes).toEqual(["S", "M", "L"]);
  });

  it("creates products on a design", async () => {
    const design = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, ctx, designInput("P1")),
    );
    const product = await withTenant(companyId, (tx) =>
      svc.createProduct(tx, ctx, {
        designId: design.id,
        brand: "Gildan",
        styleCode: "g64000",
        name: "P1 on Gildan",
        allowedColorCodes: ["blk"],
        allowedSizeCodes: ["S", "M"],
        defaultPlacements: ["front"],
        prices: [{ channel: "etsy", price: 2499 }],
      }),
    );
    expect(product.styleCode).toBe("G64000");
    expect(product.designName).toBe("Design P1");
    const listed = await withTenant(companyId, (tx) =>
      svc.listProducts(tx, ctx, { limit: 10, designId: design.id }),
    );
    expect(listed.items.map((p) => p.id)).toEqual([product.id]);
  });

  it("enforces the contract permission through the router", async () => {
    const presser = await createUser(companyId, "presser");
    const asPresser = {
      ...anonymousContext(new Headers(), null),
      sessionKind: "user" as const,
      user: { id: presser.id, name: presser.name, email: presser.email },
      companyId,
      orgType: "shop" as const,
      role: "presser" as const,
      permissions: permissionsFor("presser"),
    };
    const asDesigner = {
      ...asPresser,
      user: { id: designerId, name: "Designer", email: "designer@test.local" },
      role: "designer" as const,
      permissions: permissionsFor("designer"),
    };
    const list = await call(router.designs.list, { limit: 5 }, { context: asDesigner });
    expect(list.items.length).toBeGreaterThan(0);
    // Pressers hold production permissions only: no catalog.read, no catalog.manage.
    await expect(
      call(router.designs.list, { limit: 5 }, { context: asPresser }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { permission: "catalog.read" } });
    await expect(
      call(router.designs.create, designInput("NOPE"), { context: asDesigner }),
    ).resolves.toMatchObject({ code: "NOPE" });
    await expect(
      call(router.designs.list, { limit: 5 }, { context: anonymousContext(new Headers(), null) }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses file keys outside the company's prefix", async () => {
    const other = (await createCompany()).id;
    const foreign = designInput("X1");
    foreign.placements = foreign.placements.map((p) => ({
      ...p,
      fileKey: `${other}/design/theirs.png`,
    }));
    await expect(
      withTenant(companyId, (tx) => svc.createDesign(tx, ctx, foreign)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      withTenant(companyId, (tx) =>
        svc.bulkImportBlanks(tx, ctx, { fileKey: `${other}/csv/2026/09/blanks.csv` }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("renders a design preview and is idempotent on retry (B-209 AC1, AC4, AC5)", async () => {
    const design = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, ctx, designInput("PV1")),
    );
    const first = await svc.renderDesignPreviews(companyId, ctx, design.id);
    const firstKey = first.placements[0]?.previewKey;
    expect(firstKey).toBeTruthy();
    expect(firstKey).toMatch(new RegExp(`^${companyId}/preview/design/`));

    // Re-running (a retry, a duplicate enqueue) writes the same key, not a second object.
    const second = await svc.renderDesignPreviews(companyId, ctx, design.id);
    expect(second.placements[0]?.previewKey).toBe(firstKey);
  });

  it("refuses to preview a key outside the tenant, even imaging doesn't check (B-209 AC7)", async () => {
    const design = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, ctx, designInput("PV2")),
    );
    // Imaging trusts the backend for company prefixes (S-11/S-12); simulate a corrupted row
    // (today's service always writes a company-prefixed fileKey) to prove the defense in depth.
    const other = (await createCompany()).id;
    await withTenant(companyId, (tx) =>
      tx
        .update(designFiles)
        .set({ fileKey: `${other}/design/theirs.png` })
        .where(eq(designFiles.designId, design.id)),
    );
    await expect(svc.renderDesignPreviews(companyId, ctx, design.id)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("replacing a design's placements clears the old preview (T-P1-4 AC2)", async () => {
    const design = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, ctx, designInput("PV4")),
    );
    const rendered = await svc.renderDesignPreviews(companyId, ctx, design.id);
    expect(rendered.placements[0]?.previewKey).toBeTruthy();

    // A replace is delete+insert (service.ts updateDesign): the new row has no preview of its
    // own yet, even though it keeps the same placement kind and company prefix as the old file.
    const replaced = await withTenant(companyId, (tx) =>
      svc.updateDesign(tx, ctx, {
        id: design.id,
        placements: [
          {
            placement: "front",
            fileKey: `${companyId}/design/replacement.png`,
            widthIn: 11,
            heightIn: 12,
          },
        ],
      }),
    );
    expect(replaced.placements[0]?.previewKey).toBeNull();
  });

  it("deletes the orphaned preview object from storage once a replace commits (T-P5-2 AC1)", async () => {
    const design = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, ctx, designInput("PV5")),
    );
    const rendered = await svc.renderDesignPreviews(companyId, ctx, design.id);
    const oldKey = rendered.placements[0]?.previewKey;
    if (!oldKey) throw new Error("fixture preview missing");
    // The mocked imaging client returns an out_key without writing bytes; put a real object so
    // the delete is observable against MinIO, the way a real render would have left one.
    await putObject(oldKey, "png", "image/png");
    expect((await headObject(oldKey)).exists).toBe(true);

    await withTenant(companyId, (tx) =>
      svc.updateDesign(tx, ctx, {
        id: design.id,
        placements: [
          {
            placement: "front",
            fileKey: `${companyId}/design/replacement5.png`,
            widthIn: 11,
            heightIn: 12,
          },
        ],
      }),
    );

    expect((await headObject(oldKey)).exists).toBe(false);
  });

  it("keeps the old preview object when an order item still references it (T-P5-2 AC2)", async () => {
    const design = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, ctx, designInput("PV6")),
    );
    const rendered = await svc.renderDesignPreviews(companyId, ctx, design.id);
    const oldKey = rendered.placements[0]?.previewKey;
    if (!oldKey) throw new Error("fixture preview missing");
    await putObject(oldKey, "png", "image/png");

    const conn = await createConnection(companyId);
    await createLocation(companyId);
    const { items } = await createOrder(companyId, conn.id, { units: 1 });
    const itemId = items[0]?.id;
    if (!itemId) throw new Error("fixture item missing");
    // The item's history thumbnail points at the old key (as an item that printed straight off
    // this design, or a shipped order's timeline thumbnail, would).
    await withTenant(companyId, (tx) =>
      tx.update(orderItems).set({ artworkPreviewKey: oldKey }).where(eq(orderItems.id, itemId)),
    );

    await withTenant(companyId, (tx) =>
      svc.updateDesign(tx, ctx, {
        id: design.id,
        placements: [
          {
            placement: "front",
            fileKey: `${companyId}/design/replacement6.png`,
            widthIn: 11,
            heightIn: 12,
          },
        ],
      }),
    );

    expect((await headObject(oldKey)).exists).toBe(true);
  });

  it("backfills an item mapped before its design had a preview, without a remap (T-P5-2 AC3)", async () => {
    const design = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, ctx, designInput("PV7")),
    );
    const conn = await createConnection(companyId);
    await createLocation(companyId);
    const { items } = await createOrder(companyId, conn.id, { units: 1 });
    const itemId = items[0]?.id;
    if (!itemId) throw new Error("fixture item missing");
    // Simulate mapItems having run while the design had no preview yet (mapping.ts leaves
    // artworkPreviewKey null in that case): designId and placement set, no artwork of its own.
    await withTenant(companyId, (tx) =>
      tx
        .update(orderItems)
        .set({ designId: design.id, placement: "front" })
        .where(eq(orderItems.id, itemId)),
    );

    await svc.renderDesignPreviews(companyId, ctx, design.id);

    const [row] = await withTenant(companyId, (tx) =>
      tx
        .select({ artworkPreviewKey: orderItems.artworkPreviewKey })
        .from(orderItems)
        .where(eq(orderItems.id, itemId)),
    );
    expect(row?.artworkPreviewKey).toMatch(new RegExp(`^${companyId}/preview/design/`));
  });

  it("can't render or read another company's design (B-209 AC6, tenant isolation)", async () => {
    const design = await withTenant(companyId, (tx) =>
      svc.createDesign(tx, ctx, designInput("PV3")),
    );
    const other = (await createCompany()).id;
    const otherUser = await createUser(other, "designer");
    const otherCtx = tenantContext(other, otherUser.id, "designer");
    await expect(svc.renderDesignPreviews(other, otherCtx, design.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
