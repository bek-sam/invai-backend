/**
 * Hermetic test storage (T-43-6): backend tests delete stored files in several modules, so a test
 * run must never share the dev bucket (`invai-local`, from `.env`). This is the pure decision:
 * which bucket the run uses, and a refusal for anything that is not a test bucket. No network.
 */
export const DEFAULT_TEST_BUCKET = "invai-test";
const TEST_BUCKET = /^invai-test(-[a-z0-9]+)*$/;
const CI_BUCKET = "invai-ci";

/** True for `invai-test`, `invai-test-<suffix>`, or `invai-ci` when `CI` is set. */
export function isTestBucket(name: string, ci: boolean): boolean {
  if (TEST_BUCKET.test(name)) return true;
  return ci && name === CI_BUCKET;
}

/** Throws unless `name` may be written to and expired by a test run. */
export function assertTestBucket(name: string | undefined, ci: boolean): string {
  if (!name || !isTestBucket(name, ci)) {
    throw new Error(
      `Refusing to run tests: S3_BUCKET "${name ?? ""}" is not a test bucket. ` +
        `Tests may only use "invai-test" (or "invai-test-<suffix>"; "invai-ci" when CI is set), never the dev bucket.`,
    );
  }
  return name;
}

/**
 * The bucket for this run. `shellValue` is S3_BUCKET as the caller exported it, read before
 * `.env` is loaded; unset means the default test bucket. A pinned value is checked, not replaced,
 * so exporting the dev bucket aborts instead of being silently swapped.
 */
export function resolveTestBucket(shellValue: string | undefined, ci: boolean): string {
  return assertTestBucket(shellValue === undefined ? DEFAULT_TEST_BUCKET : shellValue, ci);
}
