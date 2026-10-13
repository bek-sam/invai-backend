import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { shipments } from "../../db/schema";
import { mockCarrier } from "../../integrations/carriers/mock";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import * as svc from "./service";

// T-47-2: a label bought at the mock's quoted (peak-surcharged) price flows into true profit as the
// bought postage plus label fee. Real clock on purpose: no surcharge amount is asserted here (the
// carrier tests pin amounts with an injected clock), only that profit follows what was bought.
const addr = (zip: string) => ({
  name: "A",
  company: null,
  street1: "1 Main St",
  street2: null,
  city: "X",
  state: "AZ",
  zip,
  country: "US",
  phone: null,
  email: null,
});

describe("true profit with a bought (possibly peak-surcharged) label", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
  });

  it("shows the bought postage plus label fee, not an estimate; no-label orders keep the average", async () => {
    const conn = await createConnection(companyId, "etsy");
    const bought = await createOrder(companyId, conn.id, { units: 2, state: "shipped" });
    const quote = await mockCarrier.rate({
      shipmentId: "3f0f6f1e-0000-4000-8000-000000000001",
      from: addr("85016"),
      to: addr("10001"),
      parcel: { lengthIn: 10, widthIn: 13, heightIn: 1, weightOz: 6 },
    } as Parameters<typeof mockCarrier.rate>[0]);
    const rate = quote.rates.find((r) => r.service === "GroundAdvantage");
    if (!rate) throw new Error("no Ground Advantage rate");
    const feeCents = 7;
    // An earlier, cheaper label on another order, so the bought cost, the 90-day average and the
    // no-label estimate are three different numbers (an estimate shown as bought must fail).
    const earlierCents = 100 + feeCents;
    const earlier = await createOrder(companyId, conn.id, { units: 1, state: "shipped" });
    await withSystem((tx) =>
      tx.insert(shipments).values({
        companyId,
        orderId: earlier.order.id,
        orderItemIds: earlier.items.map((i) => i.id),
        status: "labeled",
        postageCents: 100,
        labelFeeCents: feeCents,
        labeledAt: new Date(Date.now() - 5 * 86400_000),
      }),
    );
    await withSystem((tx) =>
      tx.insert(shipments).values({
        companyId,
        orderId: bought.order.id,
        orderItemIds: bought.items.map((i) => i.id),
        status: "labeled",
        postageCents: rate.rateCents,
        labelFeeCents: feeCents,
        labeledAt: new Date(),
      }),
    );

    const [row] = await withTenant(companyId, (tx) =>
      tx.select().from(shipments).where(eq(shipments.orderId, bought.order.id)).limit(1),
    );
    expect(row?.postageCents).toBe(rate.rateCents);

    const p = await withTenant(companyId, (tx) => svc.orderProfit(tx, ctx, bought.order.id));
    expect(p.labelCost).toBe(rate.rateCents + feeCents);
    expect(p.estimated).not.toContain("labelCost");
    const average = Math.round((rate.rateCents + feeCents + earlierCents) / 2);
    expect(rate.rateCents + feeCents).not.toBe(average);
    expect(average).not.toBe(earlierCents);

    // An order with no label yet: the 90-day average of non-voided labels, marked estimated.
    const open = await createOrder(companyId, conn.id, { units: 1, state: "imported" });
    const e = await withTenant(companyId, (tx) => svc.orderProfit(tx, ctx, open.order.id));
    expect(e.labelCost).toBe(average);
    expect(e.estimated).toContain("labelCost");
  });
});
