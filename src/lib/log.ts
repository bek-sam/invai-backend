import { env } from "../env";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[env.LOG_LEVEL];

function write(level: Level, scope: string, msg: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, scope, msg, ...data };
  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(
    env.isProd
      ? JSON.stringify(line)
      : `[${scope}] ${msg}${data ? ` ${JSON.stringify(data)}` : ""}`,
  );
}

/** Tiny structured logger. `logger("orders")` gives a scoped instance. */
export function logger(scope: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => write("debug", scope, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => write("info", scope, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => write("warn", scope, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => write("error", scope, msg, data),
  };
}

export type Logger = ReturnType<typeof logger>;

export function errorData(err: unknown): Record<string, unknown> {
  if (err instanceof Error)
    return { error: err.message, stack: env.isProd ? undefined : err.stack };
  return { error: String(err) };
}
