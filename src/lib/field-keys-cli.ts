import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newWrappedDataKey, parseStaticRing } from "./field-keys";

/**
 * Makes a new wrapped data key for the `local` field-encryption provider (T-32-2):
 *
 *   pnpm exec tsx src/lib/field-keys-cli.ts new-data-key --id <id>
 *
 * Reads FIELD_ENCRYPTION_LOCAL_MASTER_KEY (and FIELD_ENCRYPTION_KEY, to refuse an id the static
 * ring already uses) from the environment or .env, and prints one line, `<id>:<wrapped>`, ready
 * to put first in FIELD_ENCRYPTION_DATA_KEYS. It never prints the plain data key or the master
 * key. No network, no database.
 */

const USAGE = "Usage: tsx src/lib/field-keys-cli.ts new-data-key --id <id>";

type Io = { out: (line: string) => void; err: (line: string) => void };

export function runFieldKeysCli(argv: string[], env: NodeJS.ProcessEnv, io: Io): number {
  const [command, ...rest] = argv;
  const idFlag = rest.indexOf("--id");
  const id = idFlag >= 0 ? rest[idFlag + 1] : undefined;
  if (command !== "new-data-key" || !id) {
    io.err(USAGE);
    return 2;
  }
  const masterB64 = env.FIELD_ENCRYPTION_LOCAL_MASTER_KEY?.trim();
  if (!masterB64) {
    io.err("FIELD_ENCRYPTION_LOCAL_MASTER_KEY is not set");
    return 1;
  }
  const master = Buffer.from(masterB64, "base64");
  try {
    if (master.length !== 32) {
      io.err("FIELD_ENCRYPTION_LOCAL_MASTER_KEY must decode to 32 bytes");
      return 1;
    }
    if (env.FIELD_ENCRYPTION_KEY && parseStaticRing(env.FIELD_ENCRYPTION_KEY).all.has(id)) {
      io.err(`Key id ${id} is already in FIELD_ENCRYPTION_KEY; pick an id unique across rings`);
      return 1;
    }
    io.out(`${id}:${newWrappedDataKey(master, id)}`);
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    master.fill(0);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env.NODE_ENV !== "production" && !process.env.INVAI_SKIP_DOTENV) {
    for (const file of [".env", ".env.local"]) if (existsSync(file)) process.loadEnvFile(file);
  }
  process.exitCode = runFieldKeysCli(process.argv.slice(2), process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
