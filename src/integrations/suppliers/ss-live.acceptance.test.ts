import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { blankVariants, locations, purchaseOrders, suppliers } from "../../db/schema";
import * as outbox from "../../lib/outbox";
import * as svc from "../../modules/inventory/service";
import { createCompany, createLocation, createUser, tenantContext } from "../../test/fixtures";

/*
 * T-20-3 (B-71) AC3, S&S Activewear: the real REST adapter (chosen because the tenant stored
 * its own account and key) under the real inventory service, with `fetch` answering in S&S's
 * recorded shapes (seed-like data, no PII). Proves `POST /v2/orders/` carries Basic auth (never
 * asserting the key), our PO number (the idempotency handle) and `rejectLineErrors`, and that a
 * crash between the accepted POST and the commit is finished by `GET /v2/orders/{poNo}`,
 * never a second POST.
 */

vi.mock("../../lib/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/outbox")>();
  return { ...actual, emit: vi.fn(actual.emit) };
});

const SS = "https://api.ssactivewear.com/v2";
type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

describe("T-20-3 S&S live adapter over fetch, under submitPo", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let blankIds: string[];
  let calls: Call[];

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    const loc = await createLocation(companyId);
    await withSystem(async (tx) => {
      await tx
        .update(locations)
        .set({
          address: {
            name: "Receiving",
            company: "Desert Bloom Tees",
            street1: "100 Main St",
            street2: "Dock B",
            city: "Phoenix",
            state: "AZ",
            zip: "85004",
            country: "US",
            phone: null,
            email: null,
          },
        })
        .where(eq(locations.id, loc.id));
      // The tenant's own S&S account: this is what makes the adapter live.
      await tx.insert(suppliers).values({
        companyId,
        supplier: "ssactivewear",
        name: "S&S Activewear",
        accountNumber: "123456",
        apiKey: "ss-test-key-never-asserted",
      });
      blankIds = (
        await tx
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
              sku: `T203SS-BLK-${size}`,
              supplierSku: `B00760${size === "S" ? "3" : "4"}`,
              costCents: 300,
            })),
          )
          .returning()
      ).map((r) => r.id);
    });
  });

  beforeEach(() => {
    calls = [];
    vi.mocked(outbox.emit).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  function stubSs(poNo: string) {
    const rows = [
      {
        orderNumber: 555001,
        poNumber: poNo,
        orderStatus: "InProgress",
        expectedDeliveryDate: "2026-10-02",
      },
      { orderNumber: 555002, poNumber: poNo, orderStatus: "InProgress" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET";
        const headers = Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        );
        calls.push({
          method,
          url,
          headers,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (method === "POST" && url === `${SS}/orders/`)
          return new Response(JSON.stringify(rows), { status: 200 });
        if (method === "GET" && url === `${SS}/orders/${encodeURIComponent(poNo)}`)
          return new Response(JSON.stringify(rows), { status: 200 });
        throw new Error(`unexpected S&S call ${method} ${url}`);
      }),
    );
  }

  const path = (c: Call) => `${c.method} ${c.url.replace(SS, "")}`;
  const row = async (id: string) => {
    const [r] = await withSystem((tx) =>
      tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)),
    );
    if (!r) throw new Error("po missing");
    return r;
  };

  const draftPo = () =>
    withTenant(companyId, (tx) =>
      svc.createPo(tx, ctx, {
        supplier: "ssactivewear",
        lines: blankIds.map((id) => ({ blankVariantId: id, qty: 12 })),
        freight: 0,
        expectedAt: null,
        notes: null,
      }),
    );

  it("the tenant's credentials pick the live adapter", async () => {
    const list = await withTenant(companyId, (tx) => svc.listSuppliers(tx, ctx));
    expect(list.items.find((s) => s.supplier === "ssactivewear")?.provider).toBe("live");
  });

  it("orders once through a crash: POST with auth, PO number and rejectLineErrors, then GET read-back", async () => {
    const po = await draftPo();
    stubSs(po.poNo);
    vi.mocked(outbox.emit).mockImplementationOnce(async () => {
      throw new Error("simulated commit failure");
    });
    await expect(svc.submitPo(ctx, po.id)).rejects.toThrow(/simulated commit failure/);
    expect(calls.map(path)).toEqual(["POST /orders/"]);
    const post = calls[0] as Call;
    expect(post.headers.authorization).toMatch(/^Basic /);
    expect(post.headers.accept).toBe("application/json");
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.body).toMatchObject({
      poNumber: po.poNo,
      rejectLineErrors: true,
      autoselectWarehouse: true,
      testOrder: false,
      shippingAddress: { customer: "Desert Bloom Tees", city: "Phoenix", zip: "85004" },
      lines: [
        { identifier: "B007603", qty: 12 },
        { identifier: "B007604", qty: 12 },
      ],
    });
    // The key travels only in the auth header, never in the URL or the body.
    expect(JSON.stringify([post.url, post.body])).not.toMatch(/never-asserted/);
    expect(await row(po.id)).toMatchObject({
      status: "submitting",
      submitAttemptedAt: null,
      supplierOrderId: null,
    });

    calls = [];
    const submitted = await svc.submitPo(ctx, po.id);
    expect(calls.map(path)).toEqual([`GET /orders/${encodeURIComponent(po.poNo)}`]);
    expect(calls[0]?.headers.authorization).toMatch(/^Basic /);
    expect(submitted).toMatchObject({ status: "submitted", supplierOrderId: "555001,555002" });
    expect((await row(po.id)).expectedAt?.toISOString().slice(0, 10)).toBe("2026-10-02");

    // Submitting again is the stored result: no S&S call.
    calls = [];
    expect((await svc.submitPo(ctx, po.id)).supplierOrderId).toBe("555001,555002");
    expect(calls).toHaveLength(0);
  });

  it("a timeout on POST is an unknown outcome: the retry reads back and never posts again", async () => {
    const po = await draftPo();
    stubSs(po.poNo);
    const real = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          calls.push({ method: "POST", url, headers: {}, body: null });
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        return real(url, init);
      }),
    );
    await expect(svc.submitPo(ctx, po.id)).rejects.toMatchObject({ code: "UPSTREAM_FAILED" });
    expect(calls.map(path)).toEqual(["POST /orders/"]);
    expect(await row(po.id)).toMatchObject({ status: "submitting", submitAttemptedAt: null });
    calls = [];
    const submitted = await svc.submitPo(ctx, po.id);
    expect(calls.map(path)).toEqual([`GET /orders/${encodeURIComponent(po.poNo)}`]);
    expect(submitted).toMatchObject({ status: "submitted", supplierOrderId: "555001,555002" });
  });

  it("a 400 from S&S is a clear rejection: the PO goes back to draft and nothing is read back", async () => {
    const po = await draftPo();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, headers: {}, body: null });
        return new Response(JSON.stringify({ message: "Invalid SKU" }), { status: 400 });
      }),
    );
    await expect(svc.submitPo(ctx, po.id)).rejects.toMatchObject({ code: "SUPPLIER_REJECTED" });
    expect(calls.map(path)).toEqual(["POST /orders/"]);
    expect(await row(po.id)).toMatchObject({ status: "draft", submitAttemptedAt: null });
  });
});
