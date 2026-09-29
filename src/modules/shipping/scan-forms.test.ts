import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { addressVerifications, buyerPii, orders, scanForms, shipments } from "../../db/schema";
import type { CarrierExtras, CarrierScanForm } from "../../integrations/carriers";
import * as carriersModule from "../../integrations/carriers";
import { CarrierError } from "../../integrations/carriers";
import { mockCarrier } from "../../integrations/carriers/mock";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import * as svc from "./service";

/*
 * B-25 (T-22-3): USPS SCAN forms, one per company + carrier + shop-local day, crash-safe like a
 * label buy (claim, call with no transaction open, record; read back after an unknown outcome),
 * and carrier address checks that store the result (no address) and hold failed orders.
 */

vi.mock("../../integrations/carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/carriers")>();
  return { ...actual, carrierExtras: vi.fn(actual.carrierExtras) };
});

type Fake = CarrierExtras & {
  calls: { create: number; readBack: number; verify: number };
  next: (() => CarrierScanForm) | null;
  fail: CarrierError | null;
  onFile: Map<string, CarrierScanForm>;
};

function fakeCarrier(): Fake {
  const fake: Fake = {
    calls: { create: 0, readBack: 0, verify: 0 },
    next: null,
    fail: null,
    onFile: new Map(),
    async verifyAddress(input) {
      fake.calls.verify += 1;
      return mockCarrier.verifyAddress(input);
    },
    async createScanForm({ formId, carrierShipmentIds }) {
      fake.calls.create += 1;
      const form = fake.next?.() ?? {
        carrierFormId: `sf_${formId.slice(0, 8)}`,
        status: "created" as const,
        fileKey: `x/label/scanform-${formId}.pdf`,
      };
      for (const id of carrierShipmentIds) fake.onFile.set(id, form);
      const failure = fake.fail;
      fake.fail = null;
      if (failure) throw failure;
      return form;
    },
    async scanFormOf({ carrierShipmentId }) {
      fake.calls.readBack += 1;
      return fake.onFile.get(carrierShipmentId) ?? null;
    },
  };
  return fake;
}

let fake: Fake;
let companyId: string;
let connectionId: string;
let ctx: ReturnType<typeof tenantContext>;
let otherCtx: ReturnType<typeof tenantContext>;
let today: string;

/** A labeled USPS shipment bought at `labeledAt`. */
async function labeled(labeledAt = new Date(), status: "labeled" | "voided" = "labeled") {
  const { order } = await createOrder(companyId, connectionId, { units: 1, state: "shipped" });
  const [s] = await withSystem((tx) =>
    tx
      .insert(shipments)
      .values({
        companyId,
        orderId: order.id,
        status,
        carrier: "usps",
        service: "GroundAdvantage",
        trackingCode: `9400${crypto.randomUUID().replace(/\D/g, "").padEnd(18, "7").slice(0, 18)}`,
        carrierShipmentId: `shp_${crypto.randomUUID().slice(0, 12)}`,
        labeledAt,
      })
      .returning(),
  );
  if (!s) throw new Error("shipment insert failed");
  return s;
}

/** Only this test's company's forms, so the rows from earlier tests don't matter. */
async function clearForms() {
  await withSystem((tx) => tx.delete(scanForms).where(eq(scanForms.companyId, companyId)));
  await withSystem((tx) =>
    tx.update(shipments).set({ status: "voided" }).where(eq(shipments.companyId, companyId)),
  );
}

beforeAll(async () => {
  companyId = (await createCompany()).id;
  const owner = await createUser(companyId, "owner");
  ctx = tenantContext(companyId, owner.id, "office");
  connectionId = (await createConnection(companyId, "csv")).id;
  const other = (await createCompany()).id;
  otherCtx = tenantContext(other, (await createUser(other, "owner")).id, "owner");
  today = svc.shopDate("America/Phoenix");
});

beforeEach(async () => {
  fake = fakeCarrier();
  vi.mocked(carriersModule.carrierExtras).mockImplementation(async () => fake);
  await clearForms();
});

describe("SCAN forms (B-25)", () => {
  it("manifests today's labels on one form; a second create returns the same form", async () => {
    const a = await labeled();
    const b = await labeled();
    await labeled(new Date(), "voided");
    const first = await svc.createScanForm(ctx, { carrier: "usps" });
    expect(first).toMatchObject({ carrier: "usps", date: today, labelCount: 2 });
    expect(new Set(first.shipmentIds)).toEqual(new Set([a.id, b.id]));
    expect(first.carrierFormId).toMatch(/^sf_/);
    const again = await svc.createScanForm(ctx, { carrier: "usps", date: today });
    expect(again).toEqual(first);
    expect(fake.calls.create).toBe(1);
    const rows = await withTenant(companyId, (tx) => tx.select().from(scanForms));
    expect(rows).toHaveLength(1);
  });

  it("no labels waiting: NO_LABELS_TO_MANIFEST, and nothing is claimed", async () => {
    await expect(svc.createScanForm(ctx, { carrier: "usps" })).rejects.toMatchObject({
      code: "NO_LABELS_TO_MANIFEST",
    });
    expect(fake.calls.create).toBe(0);
  });

  it("a label already on a form never goes on a second one", async () => {
    const a = await labeled();
    await svc.createScanForm(ctx, { carrier: "usps" });
    // The same label now falls on another day (clock or timezone change): still excluded.
    const yesterday = new Date(Date.now() - 86400_000);
    await withSystem((tx) =>
      tx.update(shipments).set({ labeledAt: yesterday }).where(eq(shipments.id, a.id)),
    );
    await expect(
      svc.createScanForm(ctx, {
        carrier: "usps",
        date: svc.shopDate("America/Phoenix", yesterday),
      }),
    ).rejects.toMatchObject({ code: "NO_LABELS_TO_MANIFEST" });
  });

  it("a carrier refusal is SCAN_FORM_REJECTED and frees the day for a retry", async () => {
    await labeled();
    fake.fail = new CarrierError("easypost", "upstream", "different from address", "not_done");
    fake.next = null;
    const err = await svc.createScanForm(ctx, { carrier: "usps" }).catch((e) => e);
    expect(err).toMatchObject({ code: "SCAN_FORM_REJECTED", data: { detail: /from address/ } });
    fake.onFile.clear();
    const ok = await svc.createScanForm(ctx, { carrier: "usps" });
    expect(ok.labelCount).toBe(1);
    expect(fake.calls.create).toBe(2);
  });

  it("an unknown outcome is read back on retry, never created twice", async () => {
    await labeled();
    fake.fail = new CarrierError("easypost", "upstream", "timeout", "unknown");
    await expect(svc.createScanForm(ctx, { carrier: "usps" })).rejects.toMatchObject({
      code: "UPSTREAM_FAILED",
    });
    const form = await svc.createScanForm(ctx, { carrier: "usps" });
    expect(fake.calls).toMatchObject({ create: 1, readBack: 1 });
    expect(form.carrierFormId).toMatch(/^sf_/);
  });

  it("a create in flight right now is a conflict, not a second call", async () => {
    await labeled();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = fakeCarrier();
    slow.createScanForm = async (input) => {
      await gate;
      return fakeCarrier().createScanForm(input);
    };
    vi.mocked(carriersModule.carrierExtras).mockImplementation(async () => slow);
    const first = svc.createScanForm(ctx, { carrier: "usps" });
    await new Promise((r) => setTimeout(r, 100));
    await expect(svc.createScanForm(ctx, { carrier: "usps" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    release();
    await expect(first).resolves.toMatchObject({ labelCount: 1 });
  });

  it("lists and gets forms; another shop sees NOT_FOUND", async () => {
    await labeled();
    const form = await svc.createScanForm(ctx, { carrier: "usps" });
    const page = await withTenant(companyId, (tx) =>
      svc.listScanForms(tx, ctx, { limit: 10, carrier: "usps", from: today, to: today }),
    );
    expect(page.items.map((f) => f.id)).toEqual([form.id]);
    expect(await svc.getScanForm(ctx, form.id)).toEqual(form);
    await expect(svc.getScanForm(otherCtx, form.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const theirs = await withTenant(otherCtx.companyId, (tx) =>
      svc.listScanForms(tx, otherCtx, { limit: 10 }),
    );
    expect(theirs.items).toEqual([]);
  });

  it("get fills in a PDF the carrier finished rendering later", async () => {
    await labeled();
    fake.next = () => ({ carrierFormId: "sf_late", status: "creating", fileKey: null });
    const form = await svc.createScanForm(ctx, { carrier: "usps" });
    expect(form.fileKey).toBeNull();
    for (const [k] of fake.onFile)
      fake.onFile.set(k, { carrierFormId: "sf_late", status: "created", fileKey: "k/late.pdf" });
    expect((await svc.getScanForm(ctx, form.id)).fileKey).toBe("k/late.pdf");
  });
});

describe("address check (B-25)", () => {
  async function orderWith(street1: string, zip: string) {
    const { order } = await createOrder(companyId, connectionId, { units: 1 });
    await withSystem((tx) =>
      tx.insert(buyerPii).values({
        companyId,
        orderId: order.id,
        name: "José Núñez",
        street1,
        city: "Tempe",
        state: "AZ",
        zip,
      }),
    );
    return order;
  }

  it("verified: stored, and a repeat on the same address makes no carrier call", async () => {
    const order = await orderWith("4410 N 40th St", "85018");
    const first = await svc.verifyAddress(ctx, { orderId: order.id });
    expect(first).toMatchObject({ status: "verified", suggestion: null, detail: null });
    const again = await svc.verifyAddress(ctx, { orderId: order.id });
    expect(again).toEqual(first);
    expect(fake.calls.verify).toBe(1);
    const [row] = await withTenant(companyId, (tx) =>
      tx.select().from(addressVerifications).where(eq(addressVerifications.orderId, order.id)),
    );
    expect(row?.status).toBe("verified");
    // No address at rest in this table: only a keyed hash.
    expect(JSON.stringify(row)).not.toMatch(/4410|40th|Tempe|85018/);
  });

  it("corrected: returns the carrier's suggestion, never logs it", async () => {
    const order = await orderWith("200 Sample Road", "85281");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await svc.verifyAddress(ctx, { orderId: order.id });
    const lines = [...logSpy.mock.calls, ...errSpy.mock.calls].map((a) => a.join(" "));
    logSpy.mockRestore();
    errSpy.mockRestore();
    expect(out).toMatchObject({ status: "corrected", suggestion: { street1: "200 SAMPLE RD" } });
    expect(lines.some((l) => /SAMPLE|Sample|Núñez|85281/.test(l))).toBe(false);
  });

  it("failed: the order goes on the address_check hold", async () => {
    const order = await orderWith("1 Nowhere Ln", "00012");
    const out = await svc.verifyAddress(ctx, { orderId: order.id });
    expect(out).toMatchObject({ status: "failed", detail: "Address not found" });
    const [o] = await withTenant(companyId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, order.id)),
    );
    expect(o?.holdReason).toBe("address_check");
    // A repeat returns the stored result and doesn't hold twice.
    expect((await svc.verifyAddress(ctx, { orderId: order.id })).status).toBe("failed");
    expect(fake.calls.verify).toBe(1);
  });

  it("a changed address is checked again", async () => {
    const order = await orderWith("1 Nowhere Ln", "00012");
    await svc.verifyAddress(ctx, { orderId: order.id });
    await withSystem((tx) =>
      tx.update(buyerPii).set({ zip: "85281" }).where(eq(buyerPii.orderId, order.id)),
    );
    expect((await svc.verifyAddress(ctx, { orderId: order.id })).status).toBe("verified");
    expect(fake.calls.verify).toBe(2);
  });

  it("no ship-to: NO_SHIP_TO; another shop's order: NOT_FOUND", async () => {
    const { order } = await createOrder(companyId, connectionId, { units: 1 });
    await expect(svc.verifyAddress(ctx, { orderId: order.id })).rejects.toMatchObject({
      code: "NO_SHIP_TO",
    });
    const mine = await orderWith("4410 N 40th St", "85018");
    await expect(svc.verifyAddress(otherCtx, { orderId: mine.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(fake.calls.verify).toBe(0);
  });
});
