import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { blankVariants, inventoryMovements, purchaseOrders, suppliers } from "../../db/schema";
import type {
  SupplierAdapter,
  SupplierOrderInput,
  SupplierOrderLookup,
} from "../../integrations/suppliers";
import * as suppliersModule from "../../integrations/suppliers";
import * as outbox from "../../lib/outbox";
import { createCompany, createLocation, createUser, tenantContext } from "../../test/fixtures";
import * as svc from "./service";

/*
 * T-1-3: tenants never order on InvAI's supplier account, and POs are crash-safe. The supplier
 * is a fake that counts calls; the outbox `emit` can be made to fail once to simulate a commit
 * failure after the supplier accepted the order.
 */

vi.mock("../../integrations/suppliers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/suppliers")>();
  return { ...actual, getSupplierAdapter: vi.fn(actual.getSupplierAdapter) };
});
vi.mock("../../lib/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/outbox")>();
  return { ...actual, emit: vi.fn(actual.emit) };
});

const realGetAdapter = vi.mocked(suppliersModule.getSupplierAdapter).getMockImplementation();

type Fake = SupplierAdapter & {
  placed: Map<string, SupplierOrderLookup>;
  calls: { place: number; find: number; cancel: number };
  failNextPlace: suppliersModule.SupplierError | null;
  onPlace: ((input: SupplierOrderInput) => Promise<void>) | null;
};

function fakeSupplier(opts: { canCancel: boolean }): Fake {
  const fake: Fake = {
    provider: "live",
    placed: new Map(),
    calls: { place: 0, find: 0, cancel: 0 },
    failNextPlace: null,
    onPlace: null,
    async stock() {
      return [];
    },
    async products() {
      return [];
    },
    async placeOrder(input) {
      fake.calls.place += 1;
      await fake.onPlace?.(input);
      const failure = fake.failNextPlace;
      fake.failNextPlace = null;
      if (failure?.outcome === "not_placed") throw failure;
      const result = { supplierOrderId: `SS-${fake.calls.place}`, expectedAt: null };
      fake.placed.set(input.poNo, { ...result, cancelled: false });
      // An "unknown" failure: the supplier got the order, but the answer was lost.
      if (failure) throw failure;
      return result;
    },
    async findOrder(poNo) {
      fake.calls.find += 1;
      return fake.placed.get(poNo) ?? null;
    },
  };
  if (opts.canCancel) {
    fake.cancelOrder = async (supplierOrderId) => {
      fake.calls.cancel += 1;
      for (const o of fake.placed.values()) {
        if (o.supplierOrderId === supplierOrderId) o.cancelled = true;
      }
    };
  }
  return fake;
}

describe("purchase order supplier safety", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let blankIds: string[];
  let fake: Fake;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    await createLocation(companyId);
    const rows = await withSystem((tx) =>
      tx
        .insert(blankVariants)
        .values(
          ["S", "M"].map((size) => ({
            companyId,
            brand: "Gildan",
            style: "Softstyle",
            styleCode: "G64000",
            color: "Black",
            colorCode: "BLK",
            size,
            sizeCode: size,
            sku: `G64000-BLK-${size}`,
            supplierSku: `B100${size}`,
            costCents: 300,
          })),
        )
        .returning(),
    );
    blankIds = rows.map((r) => r.id);
  });

  beforeEach(() => {
    fake = fakeSupplier({ canCancel: true });
    vi.mocked(suppliersModule.getSupplierAdapter).mockImplementation(async () => fake);
    vi.mocked(outbox.emit).mockClear();
  });

  async function draftPo(supplier: "ssactivewear" | "sanmar" | "other" = "ssactivewear") {
    return withTenant(companyId, (tx) =>
      svc.createPo(tx, ctx, {
        supplier,
        lines: blankIds.map((id) => ({ blankVariantId: id, qty: 10 })),
        freight: 0,
        expectedAt: null,
        notes: null,
      }),
    );
  }

  const row = async (id: string) => {
    const [r] = await withSystem((tx) =>
      tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)),
    );
    if (!r) throw new Error("po missing");
    return r;
  };

  describe("choosing the supplier account (AC1)", () => {
    it("uses the mock, not InvAI's keys, for a tenant without credentials outside production", async () => {
      vi.mocked(suppliersModule.getSupplierAdapter).mockImplementation(realGetAdapter as never);
      const list = await withTenant(companyId, (tx) => svc.listSuppliers(tx, ctx));
      expect(list.items.find((s) => s.supplier === "ssactivewear")?.provider).toBe("mock");
      const adapter = await withTenant(companyId, (tx) =>
        svc.supplierAdapterFor(tx, companyId, "ssactivewear"),
      );
      expect(adapter?.provider).toBe("mock");
    });

    it("reports live only once the tenant's own credentials exist", async () => {
      const other = (await createCompany()).id;
      const otherCtx = tenantContext(other, (await createUser(other, "owner")).id, "owner");
      await withTenant(other, (tx) =>
        tx.insert(suppliers).values({
          companyId: other,
          supplier: "ssactivewear",
          name: "S&S Activewear",
          accountNumber: "123456",
          apiKey: "tenant-key",
        }),
      );
      const list = await withTenant(other, (tx) => svc.listSuppliers(tx, otherCtx));
      expect(list.items.find((s) => s.supplier === "ssactivewear")?.provider).toBe("live");
    });

    it("refuses to order in production until the tenant connects its account", async () => {
      vi.mocked(suppliersModule.getSupplierAdapter).mockImplementation((s, c, o) =>
        (realGetAdapter as typeof suppliersModule.getSupplierAdapter)(s, c, {
          ...o,
          production: true,
        }),
      );
      const po = await draftPo();
      await expect(svc.submitPo(ctx, po.id)).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(/Connect your S&S Activewear account/),
      });
      expect((await row(po.id)).status).toBe("draft");
    });

    it("refuses in production for a supplier with no ordering API, and fakes nothing", async () => {
      vi.mocked(suppliersModule.getSupplierAdapter).mockImplementation((s, c, o) =>
        (realGetAdapter as typeof suppliersModule.getSupplierAdapter)(s, c, {
          ...o,
          production: true,
        }),
      );
      for (const supplier of ["sanmar", "other"] as const) {
        const po = await draftPo(supplier);
        await expect(svc.submitPo(ctx, po.id)).rejects.toMatchObject({
          code: "CONFLICT",
          message:
            "This supplier has no connection yet. Place the order with the supplier directly.",
        });
        expect(await row(po.id)).toMatchObject({
          status: "draft",
          supplierOrderId: null,
          submittedAt: null,
          submitAttemptedAt: null,
        });
      }
      expect(vi.mocked(outbox.emit)).not.toHaveBeenCalledWith(
        expect.anything(),
        companyId,
        "po.submitted",
        expect.anything(),
      );
    });

    it("outside production a supplier with no API still uses the mock", async () => {
      vi.mocked(suppliersModule.getSupplierAdapter).mockImplementation(realGetAdapter as never);
      const po = await draftPo("sanmar");
      const submitted = await svc.submitPo(ctx, po.id);
      expect(submitted).toMatchObject({
        status: "submitted",
        supplierOrderId: expect.stringMatching(/^MOCK-SAN-/),
      });
    });
  });

  describe("submitPo (AC2)", () => {
    it("records intent, calls the supplier outside any transaction, then records the order", async () => {
      const po = await draftPo();
      fake.onPlace = async () => {
        // The PO row is committed as `submitting` and not locked while the supplier is called.
        const [locked] = await withTenant(companyId, (tx) =>
          tx
            .select()
            .from(purchaseOrders)
            .where(eq(purchaseOrders.id, po.id))
            .for("update", { noWait: true }),
        );
        expect(locked?.status).toBe("submitting");
        expect(locked?.submitAttemptedAt).toBeInstanceOf(Date);
      };
      const submitted = await svc.submitPo(ctx, po.id);
      expect(submitted).toMatchObject({ status: "submitted", supplierOrderId: "SS-1" });
      expect((await row(po.id)).submitAttemptedAt).toBeNull();
    });

    it("submitting twice orders once and returns the stored result", async () => {
      const po = await draftPo();
      const first = await svc.submitPo(ctx, po.id);
      const again = await svc.submitPo(ctx, po.id);
      expect(fake.calls.place).toBe(1);
      expect(again.supplierOrderId).toBe(first.supplierOrderId);
      expect(again.status).toBe("submitted");
    });

    it("a commit failure after the supplier accepted never orders twice on retry", async () => {
      const po = await draftPo();
      vi.mocked(outbox.emit).mockImplementationOnce(async () => {
        throw new Error("simulated commit failure");
      });
      await expect(svc.submitPo(ctx, po.id)).rejects.toThrow(/simulated commit failure/);
      expect(fake.calls.place).toBe(1);
      const stuck = await row(po.id);
      expect(stuck.status).toBe("submitting");
      expect(stuck.supplierOrderId).toBeNull();
      // The API doesn't expose the internal state.
      expect((await withTenant(companyId, (tx) => svc.getPo(tx, ctx, po.id))).status).toBe("draft");

      const retried = await svc.submitPo(ctx, po.id);
      expect(fake.calls.find).toBe(1);
      expect(fake.calls.place).toBe(1);
      expect(retried).toMatchObject({ status: "submitted", supplierOrderId: "SS-1" });
    });

    it("a crash mid-call blocks a retry while in flight, then reads back before ordering", async () => {
      const po = await draftPo();
      // As if the process died after tx 1 committed and the supplier took the order.
      fake.placed.set(po.poNo, {
        supplierOrderId: "SS-EARLIER",
        expectedAt: null,
        cancelled: false,
      });
      await withSystem((tx) =>
        tx
          .update(purchaseOrders)
          .set({ status: "submitting", submitAttemptedAt: new Date() })
          .where(eq(purchaseOrders.id, po.id)),
      );
      await expect(svc.submitPo(ctx, po.id)).rejects.toMatchObject({ code: "CONFLICT" });

      await withSystem((tx) =>
        tx
          .update(purchaseOrders)
          .set({ submitAttemptedAt: new Date(Date.now() - svc.SUBMIT_IN_FLIGHT_MS - 1000) })
          .where(eq(purchaseOrders.id, po.id)),
      );
      const resumed = await svc.submitPo(ctx, po.id);
      expect(fake.calls.place).toBe(0);
      expect(resumed).toMatchObject({ status: "submitted", supplierOrderId: "SS-EARLIER" });
    });

    it("a stale submitting PO the supplier never got is ordered once", async () => {
      const po = await draftPo();
      await withSystem((tx) =>
        tx
          .update(purchaseOrders)
          .set({ status: "submitting", submitAttemptedAt: null })
          .where(eq(purchaseOrders.id, po.id)),
      );
      const resumed = await svc.submitPo(ctx, po.id);
      expect(fake.calls.find).toBe(1);
      expect(fake.calls.place).toBe(1);
      expect(resumed.status).toBe("submitted");
    });

    it("a clear rejection goes back to draft", async () => {
      const po = await draftPo();
      fake.failNextPlace = new suppliersModule.SupplierError("S&S POST /orders/ -> 400", 400);
      await expect(svc.submitPo(ctx, po.id)).rejects.toMatchObject({ code: "SUPPLIER_REJECTED" });
      const r = await row(po.id);
      expect(r).toMatchObject({ status: "draft", submitAttemptedAt: null });
    });

    it("an unknown outcome stays submitting and the retry reads back", async () => {
      const po = await draftPo();
      fake.failNextPlace = new suppliersModule.SupplierError("timeout", null, "unknown");
      await expect(svc.submitPo(ctx, po.id)).rejects.toMatchObject({ code: "UPSTREAM_FAILED" });
      expect(await row(po.id)).toMatchObject({ status: "submitting", submitAttemptedAt: null });
      const retried = await svc.submitPo(ctx, po.id);
      expect(fake.calls.place).toBe(1);
      expect(retried).toMatchObject({ status: "submitted", supplierOrderId: "SS-1" });
    });
  });

  describe("receivePo (AC3)", () => {
    const onHand = async (blankVariantId: string) =>
      (await withTenant(companyId, (tx) => svc.getStock(tx, ctx, { blankVariantId }))).onHand;

    it("counts a retried receipt once, and a changed retry is a conflict", async () => {
      const po = await svc.submitPo(ctx, (await draftPo()).id);
      const line = po.lines[0];
      if (!line) throw new Error("no line");
      const before = await onHand(line.blankVariantId);
      const receipt = {
        purchaseOrderId: po.id,
        lines: [{ lineId: line.id, qty: 4 }],
        note: null,
        idempotencyKey: `rcpt-${po.id}`,
      };
      const first = await withTenant(companyId, (tx) => svc.receivePo(tx, ctx, receipt));
      const again = await withTenant(companyId, (tx) => svc.receivePo(tx, ctx, receipt));
      expect(again).toEqual(first);
      expect(await onHand(line.blankVariantId)).toBe(before + 4);
      const moves = await withSystem((tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(inventoryMovements)
          .where(eq(inventoryMovements.refId, po.id)),
      );
      expect(moves[0]?.n).toBe(1);

      await expect(
        withTenant(companyId, (tx) =>
          svc.receivePo(tx, ctx, { ...receipt, lines: [{ lineId: line.id, qty: 5 }] }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await onHand(line.blankVariantId)).toBe(before + 4);
    });

    it("the same quantities with a new key (or none) are a second delivery", async () => {
      const po = await svc.submitPo(ctx, (await draftPo()).id);
      const line = po.lines[0];
      if (!line) throw new Error("no line");
      const before = await onHand(line.blankVariantId);
      const lines = [{ lineId: line.id, qty: 3 }];
      await withTenant(companyId, (tx) =>
        svc.receivePo(tx, ctx, {
          purchaseOrderId: po.id,
          lines,
          note: null,
          idempotencyKey: "k-one-aaaa",
        }),
      );
      await withTenant(companyId, (tx) =>
        svc.receivePo(tx, ctx, {
          purchaseOrderId: po.id,
          lines,
          note: null,
          idempotencyKey: "k-two-bbbb",
        }),
      );
      const last = await withTenant(companyId, (tx) =>
        svc.receivePo(tx, ctx, { purchaseOrderId: po.id, lines, note: null }),
      );
      expect(await onHand(line.blankVariantId)).toBe(before + 9);
      expect(last.lines.find((l) => l.id === line.id)?.receivedQty).toBe(9);
    });
  });

  describe("cancelPo (AC4)", () => {
    it("cancels a draft locally without calling the supplier", async () => {
      const po = await draftPo();
      expect((await svc.cancelPo(ctx, po.id)).status).toBe("cancelled");
      expect(fake.calls.cancel).toBe(0);
    });

    it("cancels a submitted PO at the supplier first", async () => {
      const po = await svc.submitPo(ctx, (await draftPo()).id);
      const cancelled = await svc.cancelPo(ctx, po.id);
      expect(cancelled.status).toBe("cancelled");
      expect(fake.calls.cancel).toBe(1);
      expect(fake.placed.get(po.poNo)?.cancelled).toBe(true);
    });

    it("refuses when the supplier can't cancel, until the supplier shows it cancelled", async () => {
      fake = fakeSupplier({ canCancel: false });
      const po = await svc.submitPo(ctx, (await draftPo()).id);
      await expect(svc.cancelPo(ctx, po.id)).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(/Cancel it with S&S Activewear first/),
      });
      expect((await row(po.id)).status).toBe("submitted");

      const order = fake.placed.get(po.poNo);
      if (order) order.cancelled = true; // the owner cancelled it with S&S
      expect((await svc.cancelPo(ctx, po.id)).status).toBe("cancelled");
    });

    it("refuses when the supplier's cancel fails", async () => {
      const po = await svc.submitPo(ctx, (await draftPo()).id);
      fake.cancelOrder = async () => {
        throw new suppliersModule.SupplierError("only within 10 minutes");
      };
      await expect(svc.cancelPo(ctx, po.id)).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await row(po.id)).status).toBe("submitted");
    });
  });
});
