import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSupplierAdapter,
  SupplierError,
  SupplierNotConnectedError,
  supplierProvider,
} from "./index";
import { mockSupplier } from "./mock";
import { ssActivewearAdapter } from "./ssactivewear";

const creds = { account: `t13-${Date.now()}`, apiKey: "tenant-key" };

describe("getSupplierAdapter", () => {
  it("is live only with the tenant's own credentials", () => {
    expect(getSupplierAdapter("ssactivewear", creds, { production: true })?.provider).toBe("live");
    expect(supplierProvider("ssactivewear", creds, true)).toBe("live");
  });

  it("never falls back to platform keys: mock outside production", () => {
    expect(getSupplierAdapter("ssactivewear", null, { production: false })?.provider).toBe("mock");
    expect(supplierProvider("ssactivewear", null, false)).toBe("mock");
  });

  it("in production without credentials refuses to build an S&S adapter", () => {
    expect(() => getSupplierAdapter("ssactivewear", null, { production: true })).toThrow(
      SupplierNotConnectedError,
    );
    expect(supplierProvider("ssactivewear", null, true)).toBe("none");
  });

  it("in production a supplier with no API gets no adapter (nothing is faked)", () => {
    expect(getSupplierAdapter("sanmar", creds, { production: true })).toBeNull();
    expect(getSupplierAdapter("other", null, { production: true })).toBeNull();
  });
});

describe("mock supplier", () => {
  it("reads back and cancels what it placed, per account", async () => {
    const a = mockSupplier("ssactivewear", "company-a");
    const b = mockSupplier("ssactivewear", "company-b");
    const placed = await a.placeOrder({ poNo: "PO-T13-01", lines: [], shipTo: null });
    expect(await a.findOrder("PO-T13-01")).toMatchObject({ ...placed, cancelled: false });
    expect(await b.findOrder("PO-T13-01")).toBeNull();
    await a.cancelOrder?.(placed.supplierOrderId);
    expect((await a.findOrder("PO-T13-01"))?.cancelled).toBe(true);
  });
});

describe("S&S adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const shipTo = {
    name: "Receiving",
    company: "Desert Bloom",
    street1: "1 Main St",
    street2: null,
    city: "Phoenix",
    state: "AZ",
    zip: "85001",
  };

  it("sends the PO number and rejectLineErrors, and joins split orders", async () => {
    const fetch = respond(200, [
      { orderNumber: 111, poNumber: "PO-1", expectedDeliveryDate: "2026-09-28" },
      { orderNumber: 112, poNumber: "PO-1" },
    ]);
    vi.stubGlobal("fetch", fetch);
    const res = await ssActivewearAdapter(creds).placeOrder({
      poNo: "PO-1",
      lines: [{ sku: "B100S", quantity: 2 }],
      shipTo,
    });
    expect(res).toEqual({ supplierOrderId: "111,112", expectedAt: "2026-09-28" });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ poNumber: "PO-1", rejectLineErrors: true });
  });

  it("classifies failures: 4xx not placed, 5xx and timeouts unknown", async () => {
    const adapter = ssActivewearAdapter(creds);
    const order = { poNo: "PO-2", lines: [], shipTo };
    vi.stubGlobal("fetch", respond(400, { message: "bad sku" }));
    await expect(adapter.placeOrder(order)).rejects.toMatchObject({ outcome: "not_placed" });
    vi.stubGlobal("fetch", respond(503, {}));
    await expect(adapter.placeOrder(order)).rejects.toMatchObject({ outcome: "unknown" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    );
    const err = await adapter.placeOrder(order).catch((e) => e);
    expect(err).toBeInstanceOf(SupplierError);
    expect(err.outcome).toBe("unknown");
  });

  it("reads an order back by PO number, ignoring other identifiers' matches", async () => {
    const adapter = ssActivewearAdapter(creds);
    vi.stubGlobal(
      "fetch",
      respond(200, [
        { orderNumber: 7, poNumber: "SOMETHING-ELSE" },
        { orderNumber: 9, poNumber: "PO-3", orderStatus: "InProgress" },
      ]),
    );
    expect(await adapter.findOrder("PO-3")).toMatchObject({
      supplierOrderId: "9",
      cancelled: false,
    });
    vi.stubGlobal(
      "fetch",
      respond(200, [{ orderNumber: 9, poNumber: "PO-3", orderStatus: "Canceled" }]),
    );
    expect((await adapter.findOrder("PO-3"))?.cancelled).toBe(true);
    vi.stubGlobal("fetch", respond(404, { message: "not found" }));
    expect(await adapter.findOrder("PO-3")).toBeNull();
  });

  it("cancels every split order and fails when S&S didn't cancel", async () => {
    const adapter = ssActivewearAdapter(creds);
    const fetch = respond(200, [{ orderNumber: 1, orderStatus: "Cancelled" }]);
    vi.stubGlobal("fetch", fetch);
    await adapter.cancelOrder?.("1,2");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].method).toBe("DELETE");
    vi.stubGlobal("fetch", respond(200, [{ orderNumber: 1, orderStatus: "Shipped" }]));
    await expect(adapter.cancelOrder?.("1")).rejects.toThrow(/10 minutes/);
  });
});
