/*
 * Release step 1 of 3 (`node dist/db/bootstrap-cli.js`, T-30-2): create or update the app role.
 * Reads only MIGRATION_DATABASE_URL, DATABASE_URL and APP_DB_PASSWORD from the environment (no
 * src/env.ts, no .env file). See ./bootstrap.ts for what it does and does not grant.
 */
import { bootstrapAppRole, parseBootstrapConfig, runReleaseStep } from "./bootstrap";

await runReleaseStep("bootstrap", async () => {
  const r = await bootstrapAppRole(parseBootstrapConfig(process.env));
  const changes = [
    r.created ? "created" : null,
    r.fixedAttributes.length ? `fixed ${r.fixedAttributes.join(" ")}` : null,
    r.passwordUpdated ? "password updated" : null,
  ].filter(Boolean);
  const note = r.passwordVerified
    ? ""
    : " (password not checked: the server trusts this connection)";
  return `${r.appRole} on ${r.database}: ${changes.length ? changes.join(", ") : "unchanged"}${note}`;
});
