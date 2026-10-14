import { fileURLToPath } from "node:url";
import { assertScaleSeedEnv, scaleSeedEnvFrom } from "./guard";

/*
 * `pnpm db:seed:scale --profile small|mid|large` (T-54-3). Seeds one profile as its own company
 * in a scratch database. The only static import is the pure guard: it runs first, and the
 * seeding code (which reaches Valkey and the database pools at import) is loaded only after it
 * passes (architect A3.1). `seed/index.ts` and `pnpm db:seed` are not touched.
 */
export function parseProfileArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--profile") return argv[i + 1];
    if (a.startsWith("--profile=")) return a.slice("--profile=".length);
  }
  return undefined;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const profileArg = parseProfileArg(argv);
  if (!["small", "mid", "large"].includes(profileArg ?? "")) {
    console.error("[seed:scale] usage: db:seed:scale --profile small|mid|large");
    return 2;
  }
  try {
    assertScaleSeedEnv(scaleSeedEnvFrom(env));
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const seedOutputFile = env.SEED_OUTPUT_FILE as string;

  const { env: appEnv } = await import("../../../env");
  try {
    // The app's own effective settings must pass too (test mode would swap the database).
    assertScaleSeedEnv({
      databaseUrl: appEnv.DATABASE_URL,
      migrationDatabaseUrl: appEnv.MIGRATION_DATABASE_URL,
      redisUrl: appEnv.REDIS_URL,
      seedOutputFile,
    });
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const [{ eq }, { auth }, client, queues, { initFieldEncryption }, { logger }, seed, profiles] =
    await Promise.all([
      import("drizzle-orm"),
      import("../../../auth"),
      import("../../client"),
      import("../../../lib/queues"),
      import("../../../lib/crypto"),
      import("../../../lib/log"),
      import("./seed"),
      import("./profiles"),
    ]);
  const { users } = await import("../../schema");
  const log = logger("seed:scale");
  let code = 0;
  try {
    await initFieldEncryption();
    const profile = profiles.SCALE_PROFILES[profileArg as keyof typeof profiles.SCALE_PROFILES];
    const report = await seed.seedScaleProfile(profile, {
      run: (fn, companyId) => client.withSystem(fn, companyId),
      createUser: async (email, name) => {
        const res = await auth.api.signUpEmail({
          body: { email, password: seed.SCALE_PASSWORD, name },
        });
        await client.systemDb
          .update(users)
          .set({ emailVerified: true })
          .where(eq(users.id, res.user.id));
        return res.user.id;
      },
      now: Date.now(),
      log: (msg, data) => log.info(msg, data),
    });
    seed.writeReport(seedOutputFile, report);
    log.info("done", { profile: report.profile, seconds: report.seconds, ...report.counts });
  } catch (err) {
    console.error(err instanceof seed.ReplayError ? (err as Error).message : err);
    code = 1;
  } finally {
    await queues.closeQueues().catch(() => {});
    await client.closeDb();
  }
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
