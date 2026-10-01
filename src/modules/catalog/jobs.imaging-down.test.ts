import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { withTenant } from "../../db/client";
import { designFiles } from "../../db/schema";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { createDesign } from "./service";

/*
 * T-P2-2 round 2 (`reviews/T-P2-2-reviewer-r1.md` finding 1): `jobs.test.ts`'s "transient imaging
 * failure" test mocks `imaging.preview` itself, so it never runs the real HTTP client and can't
 * see the client's own placeholder fallback — the exact path the review found broken. Here the
 * client is real (`createImagingClient`), pointed at a closed local port, so `fetch` genuinely
 * fails to connect and `/health` fails the same way: a true "imaging unreachable" case, not a
 * mock rejection. This file doesn't mock `imaging.preview`'s behavior at all, only its target URL.
 *
 * Red on f6002ff: the render job called the client with no `allowPlaceholder` option, so the
 * client's `checkHealthy()` branch ran, wrote a gray placeholder to `preview_key` and returned a
 * fake-success result — the job completed and `preview_key` was non-null. Green after the round-2
 * fix: the job passes `allowPlaceholder: false`, the client rethrows instead, the job throws and
 * `preview_key` stays null.
 */
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  // Port 1 is never listening locally: fetch fails fast with "connection refused", for both
  // `/preview` and the client's own `/health` check, with no flaky network timeout to wait out.
  return { ...actual, imaging: actual.createImagingClient("http://127.0.0.1:1") };
});

const { runJobInline } = await import("../../lib/queues");
const { renderDesignPreviewsJob } = await import("./jobs");

describe("catalog.renderDesignPreviews job, imaging genuinely unreachable (T-P2-2 round 2)", () => {
  it("never writes a placeholder: throws so the job retries, preview_key stays null", async () => {
    const companyId = (await createCompany()).id;
    const designer = await createUser(companyId, "designer");
    const ctx = tenantContext(companyId, designer.id, "designer");
    const design = await withTenant(companyId, (tx) =>
      createDesign(tx, ctx, {
        code: "JOBDOWN",
        name: "Job design, imaging down",
        tags: [],
        placements: [
          { placement: "front", fileKey: `${companyId}/design/x.png`, widthIn: 10, heightIn: 11 },
        ],
        personalizationTemplateId: null,
      }),
    );

    await expect(
      runJobInline(renderDesignPreviewsJob, { companyId, designId: design.id }),
    ).rejects.toThrow();

    const [row] = await withTenant(companyId, (tx) =>
      tx
        .select({ previewKey: designFiles.previewKey })
        .from(designFiles)
        .where(eq(designFiles.designId, design.id)),
    );
    expect(row?.previewKey).toBeNull();
  });
});
