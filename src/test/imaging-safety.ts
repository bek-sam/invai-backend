import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Hermetic imaging for tests (T-44-5, B-401, S-80): `.env` names a live imaging service
 * (`IMAGING_URL=http://localhost:8000`), and any test that reaches it makes it render and write
 * files into whatever bucket it is configured with. A test run therefore never uses the shell's
 * or `.env`'s `IMAGING_URL` (the gate exports `IMAGING_URL=http://localhost:8100` for its whole
 * run, so "the shell wins" would reach live imaging). Only `TEST_IMAGING_URL` opts in. No network.
 */
export const CLOSED_IMAGING_URL = "http://127.0.0.1:1";
const LIVE_PORTS = new Set(["8000", "8100"]);

/** The port a URL really connects to: WHATWG `URL` leaves `port` empty for the scheme default. */
function effectivePort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === "https:" ? "443" : "80";
}

/**
 * The `IMAGING_URL` value(s) a file names, read with `util.parseEnv` (no process.env writes).
 * `process.loadEnvFile` never overrides an exported variable, so the shell value hides `.env`'s
 * own; the guard needs both (T-45-3, S-82). A missing file means no value.
 */
export function readEnvFileImagingUrls(
  files: readonly string[],
  read: (file: string) => string | undefined = (f) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return undefined;
    }
  },
): string[] {
  const out: string[] = [];
  for (const f of files) {
    const text = read(f);
    const v = text === undefined ? undefined : parseEnv(text).IMAGING_URL;
    if (v) out.push(v);
  }
  return out;
}

/**
 * The imaging URL for this run. `optIn` is `TEST_IMAGING_URL` as exported by the caller; unset
 * means the closed port. `liveUrls` are the shell and `.env` `IMAGING_URL` values (the "live"
 * ones). An opt-in is refused when its PORT is 8000, 8100 or the port of any live URL, on any
 * host (T-45-3, S-82): spellings of the host (`localhost.`, `127.0.0.2`, `[::]`, v4-mapped v6,
 * LAN or docker names) cannot get past a port rule, and no DNS lookup is needed. An opt-in on
 * another port is accepted.
 */
export function resolveTestImagingUrl(
  optIn: string | undefined,
  liveUrls?: string | readonly (string | undefined)[],
): string {
  if (optIn === undefined || optIn === "") return CLOSED_IMAGING_URL;
  let url: URL;
  try {
    url = new URL(optIn);
  } catch {
    throw new Error(`Refusing to run tests: TEST_IMAGING_URL "${optIn}" is not a URL.`);
  }
  const livePorts = new Set(LIVE_PORTS);
  const list = typeof liveUrls === "string" ? [liveUrls] : (liveUrls ?? []);
  for (const raw of list) {
    if (!raw) continue;
    try {
      livePorts.add(effectivePort(new URL(raw)));
    } catch {
      // an unparsable live value names no endpoint
    }
  }
  const port = effectivePort(url);
  if (livePorts.has(port)) {
    throw new Error(
      `Refusing to run tests: TEST_IMAGING_URL "${optIn}" (host ${url.hostname}, port ${port}) ` +
        `uses the port of a live imaging service (:8000, :8100 or the IMAGING_URL from .env/the shell). ` +
        `Tests render and write files through it, under any host name. ` +
        `Use a stub or a dedicated test imaging on another port.`,
    );
  }
  return url.toString().replace(/\/$/, "");
}
