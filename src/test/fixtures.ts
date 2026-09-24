import { sql } from "drizzle-orm";
import { permissionsFor, type TenantContext } from "../api/context";
import { withSystem } from "../db/client";
import type { Channel, CompanyType, Role } from "../db/schema";
import {
  channelConnections,
  companies,
  locations,
  members,
  orderItems,
  orders,
  stations,
  users,
} from "../db/schema";
import { systemActor } from "../lib/audit";

/*
 * Test fixtures. Tests run against the `invai_test` database (see global-setup.ts) and
 * create their own companies, so RLS is exercised for real: use `withTenant(company.id, ...)`
 * in the test body exactly like production code does.
 *
 *   const shop = await createCompany();
 *   const owner = await createUser(shop.id, "owner");
 *   const ctx = tenantContext(shop.id, owner.id, "owner");
 *   await withTenant(shop.id, (tx) => createDesign(tx, ctx, {...}));
 */

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Truncate every table except the global catalogs. Call in `beforeAll` when a file needs a clean slate. */
export async function truncateAll() {
  await withSystem(async (tx) => {
    const rows = await tx.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public' and tablename not in ('plans', 'trademark_marks')`,
    );
    const names = rows.rows.map((r) => `"${r.tablename}"`).join(", ");
    if (names) await tx.execute(sql.raw(`TRUNCATE TABLE ${names} CASCADE`));
  });
}

export async function createCompany(input: { name?: string; type?: CompanyType } = {}) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(companies)
      .values({
        name: input.name ?? `Test Co ${uniq()}`,
        slug: `test-${uniq()}`,
        type: input.type ?? "shop",
        plan: input.type === "vendor" ? null : "trial",
      })
      .returning(),
  );
  if (!row) throw new Error("company insert failed");
  return row;
}

export async function createUser(
  companyId: string,
  role: Role,
  input: { name?: string; email?: string } = {},
) {
  return withSystem(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        name: input.name ?? `${role} ${uniq()}`,
        email: input.email ?? `${role}-${uniq()}@test.local`,
      })
      .returning();
    if (!user) throw new Error("user insert failed");
    await tx.insert(members).values({ organizationId: companyId, userId: user.id, role });
    return user;
  });
}

export async function createLocation(companyId: string, name = "Main") {
  const [row] = await withSystem((tx) =>
    tx.insert(locations).values({ companyId, name, isDefault: true }).returning(),
  );
  if (!row) throw new Error("location insert failed");
  return row;
}

export async function createStation(companyId: string, locationId: string, name = "Press 1") {
  const [row] = await withSystem((tx) =>
    tx.insert(stations).values({ companyId, locationId, name, kind: "press" }).returning(),
  );
  if (!row) throw new Error("station insert failed");
  return row;
}

export async function createConnection(companyId: string, channel: Channel = "csv") {
  const [row] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({ companyId, channel, name: `${channel} test`, status: "csv_only", mode: "csv" })
      .returning(),
  );
  if (!row) throw new Error("connection insert failed");
  return row;
}

/** An order with `units` items in state `imported` (or the given state). */
export async function createOrder(
  companyId: string,
  connectionId: string,
  input: {
    units?: number;
    state?: (typeof orderItems.$inferInsert)["state"];
    channel?: Channel;
  } = {},
) {
  const units = input.units ?? 1;
  return withSystem(async (tx) => {
    const shipBy = new Date(Date.now() + 2 * 86400_000);
    const [order] = await tx
      .insert(orders)
      .values({
        companyId,
        connectionId,
        channel: input.channel ?? "csv",
        channelOrderId: `ord-${uniq()}`,
        orderNo: `T-${uniq()}`,
        placedAt: new Date(),
        shipBy,
        itemCount: units,
        subtotalCents: 2500 * units,
        totalCents: 2500 * units,
      })
      .returning();
    if (!order) throw new Error("order insert failed");
    const items = await tx
      .insert(orderItems)
      .values(
        Array.from({ length: units }, (_, i) => ({
          companyId,
          orderId: order.id,
          lineNo: 1,
          unitNo: i + 1,
          unitsInLine: units,
          channelLineId: "L1",
          channelSku: "TEST-SKU",
          title: "Test tee",
          unitPriceCents: 2500,
          shipBy,
          state: input.state ?? "imported",
        })),
      )
      .returning();
    return { order, items };
  });
}

/** A TenantContext as the oRPC `authed` builder would produce it. */
export function tenantContext(
  companyId: string,
  userId: string | null,
  role: Role | null,
  orgType: CompanyType = "shop",
): TenantContext {
  return {
    companyId,
    orgType,
    userId,
    role,
    permissions: permissionsFor(role),
    sessionKind: userId ? "user" : "station",
    station: null,
    user: userId ? { id: userId, name: "Test", email: "test@test.local" } : null,
    actor: userId ? { kind: "user", userId } : systemActor,
  };
}
