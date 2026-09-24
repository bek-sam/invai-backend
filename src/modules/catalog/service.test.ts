import { call } from "@orpc/server";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withTenant } from "../../db/client";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
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
});
