import { pgRole, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** The role the app connects as. Not the table owner, no BYPASSRLS. */
export const appRole = pgRole("invai_app", { createRole: false });

export const companies = pgTable("companies", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  plan: text().notNull().default("starter"),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
