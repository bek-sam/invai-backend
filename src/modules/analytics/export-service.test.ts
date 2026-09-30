import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import { blankVariants, companies, designs, listings, stockLevels } from "../../db/schema";
import { getObject } from "../../lib/s3";
import {
  createCompany,
  createConnection,
  createLocation,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { exportAnalyticsCsv } from "./export-service";

/*
 * T-A5 `analytics.export` (spec AC-E6): one CSV per view, uploaded to S3, with headers matching
 * that view's own row shape. The underlying numbers are covered by finance-service.test.ts,
 * operations-service.test.ts, inventory-service.test.ts and design-service.test.ts; this file
 * only proves the plumbing -- discriminated dispatch, the CSV file, tenant isolation and auth.
 */

const PERIOD = { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" };

async function seedShop() {
  const company = await createCompany();
  await withSystem((tx) =>
    tx.update(companies).set({ timezone: "UTC" }).where(eq(companies.id, company.id)),
  );
  const owner = await createUser(company.id, "owner");
  const ctx = tenantContext(company.id, owner.id, "owner");

  // Enough for inventoryHealth/designLifecycle to return a non-empty sheet.
  const location = await createLocation(company.id);
  const [bv] = await withSystem((tx) =>
    tx
      .insert(blankVariants)
      .values({
        companyId: company.id,
        brand: "Gildan",
        style: "Tee",
        styleCode: "G64000",
        color: "Sand",
        colorCode: "SND",
        size: "M",
        sizeCode: "M",
        sku: `SKU-${company.id}`,
        costCents: 300,
      })
      .returning(),
  );
  if (!bv) throw new Error("seed failed");
  await withSystem((tx) =>
    tx.insert(stockLevels).values({
      companyId: company.id,
      blankVariantId: bv.id,
      locationId: location.id,
      onHand: 5,
      available: 5,
    }),
  );
  const connectionId = (await createConnection(company.id, "etsy")).id;
  const [design] = await withSystem((tx) =>
    tx.insert(designs).values({ companyId: company.id, code: "D1", name: "Sample" }).returning(),
  );
  if (!design) throw new Error("seed failed");
  await withSystem((tx) =>
    tx.insert(listings).values({
      companyId: company.id,
      connectionId,
      channel: "etsy",
      channelListingId: "L1",
      title: "Listing",
      state: "active",
      designId: design.id,
    }),
  );

  return { companyId: company.id, ctx };
}

let a: Awaited<ReturnType<typeof seedShop>>;

beforeAll(async () => {
  a = await seedShop();
}, 30_000);

describe("analytics.export", () => {
  it("unitEconomics: uploads a CSV keyed under the company, with the ladder's headers", async () => {
    const { key } = await withTenant(a.companyId, (tx) =>
      exportAnalyticsCsv(tx, a.ctx, {
        view: "unitEconomics",
        period: PERIOD,
        dimension: "channel",
      }),
    );
    expect(key).toMatch(new RegExp(`^${a.companyId}/analytics-export/`));
    const csv = (await getObject(key)).toString("utf8");
    const [header, ...rows] = csv.trim().split("\r\n");
    expect(header?.split(",")).toEqual([
      "key",
      "label",
      "orders",
      "units",
      "revenue",
      "cm1",
      "cm2",
      "cm3",
      "cm1Pct",
      "cm2Pct",
      "cm3Pct",
      "estimatedShare",
    ]);
    // Always at least the TOTAL row.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)).toMatch(/^TOTAL,Total,/);
  });

  it("inventoryHealth: the dead-stock rows, no buyer data in any column", async () => {
    const { key } = await withTenant(a.companyId, (tx) =>
      exportAnalyticsCsv(tx, a.ctx, { view: "inventoryHealth", days: 90 }),
    );
    const csv = (await getObject(key)).toString("utf8");
    expect(csv.split("\r\n")[0]).toBe("blankVariantId,label,onHand,value,lastConsumedAt");
    expect(csv).not.toMatch(/@/); // no email-shaped text anywhere in the file
  });

  it("supplierTrends and designLifecycle export without error", async () => {
    const st = await withTenant(a.companyId, (tx) =>
      exportAnalyticsCsv(tx, a.ctx, { view: "supplierTrends", period: PERIOD }),
    );
    expect(st.key).toMatch(/\.csv$/);
    const dl = await withTenant(a.companyId, (tx) =>
      exportAnalyticsCsv(tx, a.ctx, { view: "designLifecycle", asOf: "2026-06-01" }),
    );
    const csv = (await getObject(dl.key)).toString("utf8");
    expect(csv).toContain("Sample"); // the seeded design's name
  });

  it("the owner reaches export through the router; a role without finance.read gets FORBIDDEN (AC-E5)", async () => {
    const owner = await createUser(a.companyId, "owner");
    const ownerCtx = {
      ...anonymousContext(new Headers(), null),
      sessionKind: "user" as const,
      user: { id: owner.id, name: owner.name, email: owner.email },
      companyId: a.companyId,
      orgType: "shop" as const,
      role: "owner" as const,
      permissions: permissionsFor("owner"),
    };
    const r = await call(
      router.analytics.export,
      { view: "inventoryHealth", days: 90 },
      { context: ownerCtx },
    );
    expect(r.key).toMatch(/\.csv$/);

    const receiver = await createUser(a.companyId, "receiver");
    const context = {
      ...ownerCtx,
      user: { id: receiver.id, name: receiver.name, email: receiver.email },
      role: "receiver" as const,
      permissions: permissionsFor("receiver"),
    };
    await expect(
      call(router.analytics.export, { view: "inventoryHealth", days: 90 }, { context }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { permission: "finance.read" },
    });
  });
});
