import { defineConfig } from "drizzle-kit";

// drizzle-kit runs as the owner role; the app never has DDL rights.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? "" },
  entities: { roles: { include: ["invai_app"] } },
});
