import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { orders } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { listOrders, listOrdersQuery } from "./service";

/*
 * T-56-2 (B-480): the default orders list (sort shipBy) must read orders_company_id_ship_by_id_index
 * in key order, with the LIMIT, and no Sort node. The planner is steered with enable_* switches so a
 * tiny test table gives the plan a big one would; the SQL under EXPLAIN is the production builder.
 */

const INDEX = "orders_company_id_ship_by_id_index";
type PlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Scan Direction"?: string;
  Plans?: PlanNode[];
};
const walk = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => {
  out.push(n);
  for (const c of n.Plans ?? []) walk(c, out);
  return out;
};

type Input = Parameters<typeof listOrders>[2];
const base: Input = { limit: 10, sort: "shipBy", dir: "asc" };
const cursor = (v: Date, id: string) =>
  Buffer.from(JSON.stringify({ v: v.toISOString(), id })).toString("base64url");

let companyId: string;
let ctx: ReturnType<typeof tenantContext>;

beforeAll(async () => {
  const mk = async () => {
    const c = await createCompany();
    const u = await createUser(c.id, "office");
    const conn = await createConnection(c.id);
    for (let i = 0; i < 6; i++) await createOrder(c.id, conn.id, { units: 1 });
    return { c, u };
  };
  const a = await mk();
  await mk();
  companyId = a.c.id;
  ctx = tenantContext(a.c.id, a.u.id, "office");
  const days = [5, 4, 3, 2, 1, 0];
  const rows = await withSystem((tx) =>
    tx.select({ id: orders.id }).from(orders).where(sql`company_id = ${companyId}`),
  );
  for (const [i, r] of rows.entries()) {
    await withSystem((tx) =>
      tx
        .update(orders)
        .set({ shipBy: new Date(Date.now() + (days[i] ?? 0) * 86400_000) })
        .where(sql`id = ${r.id}`),
    );
  }
});

async function plan(input: Input) {
  return withTenant(companyId, async (tx) => {
    for (const g of [
      "enable_seqscan",
      "enable_bitmapscan",
      "enable_sort",
      "enable_incremental_sort",
    ])
      await tx.execute(sql.raw(`set local ${g} = off`));
    const res = await tx.execute(
      sql`explain (format json, costs off) ${listOrdersQuery(tx, ctx, input)}`,
    );
    const row = (res as unknown as { rows: { "QUERY PLAN": { Plan: PlanNode }[] }[] }).rows[0];
    if (!row) throw new Error("no plan");
    return walk(row["QUERY PLAN"][0]?.Plan as PlanNode);
  });
}

describe("orders.list default plan", () => {
  for (const dir of ["asc", "desc"] as const) {
    for (const paged of [false, true]) {
      it(`${dir} ${paged ? "cursor page" : "first page"} reads the ship_by index with no Sort`, async () => {
        const input: Input = {
          ...base,
          dir,
          cursor: paged
            ? cursor(new Date(Date.now() + 2 * 86400_000), crypto.randomUUID())
            : undefined,
        };
        const nodes = await plan(input);
        const types = nodes.map((n) => n["Node Type"]);
        const idx = nodes.find((n) => n["Index Name"] === INDEX);
        expect(idx?.["Node Type"]).toBe("Index Scan");
        expect(idx?.["Scan Direction"]).toBe(dir === "asc" ? "Forward" : "Backward");
        expect(types.some((t) => t.includes("Sort"))).toBe(false);
        expect(types).toContain("Limit");
        if (paged) expect(idx?.["Index Cond"]).toContain("ship_by");
      });
    }
  }

  it("still pages through the company's orders in (ship_by, id) order without gaps", async () => {
    const seen: string[] = [];
    let cur: string | undefined;
    for (let i = 0; i < 4; i++) {
      const page = await withTenant(companyId, (tx) =>
        listOrders(tx, ctx, { ...base, limit: 2, cursor: cur }),
      );
      seen.push(...page.items.map((o) => o.id));
      cur = page.nextCursor ?? undefined;
      if (!cur) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });
});
