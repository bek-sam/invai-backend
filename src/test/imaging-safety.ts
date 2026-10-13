/**
 * Hermetic imaging for tests (T-44-5, B-401, S-80): `.env` names a live imaging service
 * (`IMAGING_URL=http://localhost:8000`), and any test that reaches it makes it render and write
 * files into whatever bucket it is configured with. A test run therefore never uses the shell's
 * or `.env`'s `IMAGING_URL` (the gate exports `IMAGING_URL=http://localhost:8100` for its whole
 * run, so "the shell wins" would reach live imaging). Only `TEST_IMAGING_URL` opts in. No network.
 */
export const CLOSED_IMAGING_URL = "http://127.0.0.1:1";
const LIVE_PORTS = new Set(["8000", "8100"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

function sameEndpoint(a: URL, b: URL): boolean {
  return a.hostname === b.hostname && (a.port || "80") === (b.port || "80");
}

/**
 * The imaging URL for this run. `optIn` is `TEST_IMAGING_URL` as exported by the caller; unset
 * means the closed port. `envFileUrl` is the `.env`/shell `IMAGING_URL` (the "live" one): an
 * opt-in that points at it, or at a local :8000/:8100, is refused.
 */
export function resolveTestImagingUrl(optIn: string | undefined, envFileUrl?: string): string {
  if (optIn === undefined || optIn === "") return CLOSED_IMAGING_URL;
  let url: URL;
  try {
    url = new URL(optIn);
  } catch {
    throw new Error(`Refusing to run tests: TEST_IMAGING_URL "${optIn}" is not a URL.`);
  }
  const live = LOCAL_HOSTS.has(url.hostname) && LIVE_PORTS.has(url.port);
  let matchesEnv = false;
  if (envFileUrl) {
    try {
      matchesEnv = sameEndpoint(url, new URL(envFileUrl));
    } catch {
      matchesEnv = false;
    }
  }
  if (live || matchesEnv) {
    throw new Error(
      `Refusing to run tests: TEST_IMAGING_URL "${optIn}" points at a live imaging service ` +
        `(:8000, :8100 or the IMAGING_URL from .env/the shell). Tests render and write files through it. ` +
        `Use a stub or a dedicated test imaging on another port.`,
    );
  }
  return url.toString().replace(/\/$/, "");
}
