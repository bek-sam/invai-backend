import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { auditLog, orderNotes } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { setTags, timeline } from "./service";

/*
 * T-53-3 (B-459, decision 0027 amendment): the order_notes table keeps tenancy at the database
 * (composite FK + RLS), and the tag audit summary never carries the tag text.
 */

const pgCode = (e: unknown): string | undefined => {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.cause?.code ?? x?.code;
};
const failure = async (fn: () => Promise<unknown>) =>
  fn().then(
    () => null,
    (e: unknown) => e,
  );

type Side = { companyId: string; orderId: string; ctx: ReturnType<typeof tenantContext> };
let a: Side;
let b: Side;

async function side(): Promise<Side> {
  const companyId = (await createCompany()).id;
  const user = await createUser(companyId, "office");
  const conn = await createConnection(companyId);
  const { order } = await createOrder(companyId, conn.id, { units: 1 });
  return { companyId, orderId: order.id, ctx: tenantContext(companyId, user.id, "office") };
}

beforeAll(async () => {
  a = await side();
  b = await side();
  await withSystem((tx) =>
    tx
      .insert(orderNotes)
      .values({ companyId: a.companyId, orderId: a.orderId, kind: "note", text: "Probe A note" }),
  );
});

describe("order_notes tenancy", () => {
  it("refuses a note of company A that points at company B's order (composite FK 23503)", async () => {
    const err = await failure(() =>
      withTenant(a.companyId, (tx) =>
        tx
          .insert(orderNotes)
          .values({ companyId: a.companyId, orderId: b.orderId, kind: "note", text: "Probe x" }),
      ),
    );
    expect(pgCode(err)).toBe("23503");
  });

  it("refuses a row for company B written under company A's tenant (RLS 42501)", async () => {
    const err = await failure(() =>
      withTenant(a.companyId, (tx) =>
        tx
          .insert(orderNotes)
          .values({ companyId: b.companyId, orderId: b.orderId, kind: "note", text: "Probe y" }),
      ),
    );
    expect(pgCode(err)).toBe("42501");
  });

  it("company B cannot read company A's note: 0 rows, and the timeline is NOT_FOUND", async () => {
    const rows = await withTenant(b.companyId, (tx) =>
      tx.select().from(orderNotes).where(eq(orderNotes.orderId, a.orderId)),
    );
    expect(rows).toHaveLength(0);
    const err = await failure(() =>
      withTenant(b.companyId, (tx) => timeline(tx, b.ctx, { id: a.orderId, limit: 50 })),
    );
    expect(err).toMatchObject({ code: "NOT_FOUND" });
    const own = await withTenant(a.companyId, (tx) =>
      tx.select().from(orderNotes).where(eq(orderNotes.orderId, a.orderId)),
    );
    expect(own).toHaveLength(1);
  });
});

describe("setTags audit summary", () => {
  const summaries = (s: Side) =>
    withTenant(s.companyId, (tx) =>
      tx
        .select({ summary: auditLog.summary })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, s.orderId), eq(auditLog.action, "order.tags"))),
    );

  it("writes a fixed text with a count, never the tag text; tags stay on the order", async () => {
    const out = await withTenant(a.companyId, (tx) =>
      setTags(tx, a.ctx, { id: a.orderId, tags: ["probe-vip", " probe-rush ", "probe-vip"] }),
    );
    expect(out.tags).toEqual(["probe-vip", "probe-rush"]);
    expect((await summaries(a)).map((r) => r.summary)).toEqual(["Tags updated (2)"]);
    await withTenant(a.companyId, (tx) => setTags(tx, a.ctx, { id: a.orderId, tags: [] }));
    const all = (await summaries(a)).map((r) => r.summary).sort();
    expect(all).toEqual(["Tags cleared", "Tags updated (2)"]);
    expect(JSON.stringify(all)).not.toContain("probe-");
    const tl = await withTenant(a.companyId, (tx) =>
      timeline(tx, a.ctx, { id: a.orderId, limit: 50 }),
    );
    expect(JSON.stringify(tl.items)).not.toContain("probe-vip");
  });
});
