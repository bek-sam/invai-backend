import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { alerts, blankVariants, purchaseOrders } from "../../db/schema";
import { runJobInline } from "../../lib/queues";
import { createCompany, createLocation, createUser, tenantContext } from "../../test/fixtures";
import { stuckSubmittingPoJob } from "./jobs";
import * as svc from "./service";

/*
 * T-6-1 AC3: a PO stuck in `submitting` for more than 15 minutes raises an alert. Verified with
 * a backdated `submitAttemptedAt` fixture, not a live wait.
 */
describe("stuckSubmittingPoJob", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let blankId: string;

  beforeEach(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    await createLocation(companyId);
    const [row] = await withSystem((tx) =>
      tx
        .insert(blankVariants)
        .values({
          companyId,
          brand: "Gildan",
          style: "Softstyle",
          styleCode: "G64000",
          color: "Black",
          colorCode: "BLK",
          size: "M",
          sizeCode: "M",
          sku: "G64000-BLK-M",
          supplierSku: "B100M",
          costCents: 300,
        })
        .returning(),
    );
    blankId = (row as { id: string }).id;
  });

  async function draftPo() {
    return withTenant(companyId, (tx) =>
      svc.createPo(tx, ctx, {
        supplier: "ssactivewear",
        lines: [{ blankVariantId: blankId, qty: 5 }],
        freight: 0,
        expectedAt: null,
        notes: null,
      }),
    );
  }

  async function backdateToSubmitting(poId: string, minutesAgo: number) {
    await withSystem((tx) =>
      tx
        .update(purchaseOrders)
        .set({
          status: "submitting",
          submitAttemptedAt: new Date(Date.now() - minutesAgo * 60_000),
        })
        .where(eq(purchaseOrders.id, poId)),
    );
  }

  it("alerts once a submitting PO has been stuck for over 15 minutes", async () => {
    const po = await draftPo();
    await backdateToSubmitting(po.id, 20);
    const res = await runJobInline(stuckSubmittingPoJob, { companyId, bucket: 1 });
    expect(res).toEqual({ stuck: 1 });
    const [alert] = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.companyId, companyId),
            eq(alerts.dedupeKey, `po-stuck-submitting-${po.id}`),
          ),
        ),
    );
    expect(alert).toMatchObject({ kind: "sync_broken", severity: "warning" });
  });

  it("does not alert a submitting PO still inside the in-flight window", async () => {
    const po = await draftPo();
    await backdateToSubmitting(po.id, 5);
    const res = await runJobInline(stuckSubmittingPoJob, { companyId, bucket: 2 });
    expect(res).toEqual({ stuck: 0 });
    const found = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.companyId, companyId),
            eq(alerts.dedupeKey, `po-stuck-submitting-${po.id}`),
          ),
        ),
    );
    expect(found).toHaveLength(0);
  });
});
