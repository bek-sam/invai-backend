import { sql } from "drizzle-orm";
import { index, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appRole, companies } from "./tenancy";

const tenantOnly = sql`company_id = (select current_setting('app.company_id', true))::uuid`;

export const orders = pgTable(
  "orders",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    channel: text().notNull(),
    channelOrderId: text().notNull(),
    shipBy: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.companyId, t.shipBy),
    pgPolicy("orders_tenant", {
      for: "all",
      to: appRole,
      using: tenantOnly,
      withCheck: tenantOnly,
    }),
  ],
).enableRLS();
