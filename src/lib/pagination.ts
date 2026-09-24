import { and, desc, lt, or, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { badRequest } from "./errors";

/**
 * Keyset pagination on (created_at desc, id desc). Every list procedure in the contract takes
 * `{ cursor?, limit }` and returns `{ items, nextCursor }`:
 *
 *   const page = keyset(orders.createdAt, orders.id, input);
 *   const rows = await tx.select().from(orders).where(and(filters, page.where)).orderBy(...page.orderBy).limit(page.limit + 1);
 *   return page.result(rows, (r) => toOrder(r));
 */
export type PageInput = { cursor?: string | undefined; limit: number };

type Row = { createdAt: Date; id: string };

export function keyset(createdAt: PgColumn, id: PgColumn, input: PageInput) {
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const where: SQL | undefined = cursor
    ? or(
        lt(createdAt, cursor.createdAt),
        and(sql`${createdAt} = ${cursor.createdAt}`, lt(id, cursor.id)),
      )
    : undefined;
  return {
    where,
    orderBy: [desc(createdAt), desc(id)],
    limit: input.limit,
    /** Trims the extra row fetched with `limit + 1` and builds the next cursor. */
    result<R extends Row, T>(
      rows: R[],
      map: (row: R) => T,
    ): { items: T[]; nextCursor: string | null } {
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(map),
        nextCursor: hasMore && last ? encodeCursor(last) : null,
      };
    },
  };
}

export function encodeCursor(row: Row): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url");
}

export function decodeCursor(cursor: string): Row {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const [ts, id] = raw.split("|");
  const createdAt = ts ? new Date(ts) : new Date(Number.NaN);
  if (!id || Number.isNaN(createdAt.getTime())) throw badRequest("Invalid cursor");
  return { createdAt, id };
}
