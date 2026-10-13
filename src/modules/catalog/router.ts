import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import { rateLimited } from "../../lib/errors";
import { isImagingBusy, QA_MANUAL_BUSY, retrySeconds, takeQaTurn } from "./qa-turn";
import * as svc from "./service";

/*
 * Catalog handlers: one line each. The handler unwraps the tenant, opens the tenant-scoped
 * transaction and calls the service. Input/output validation is the contract's job.
 */

export const designsRouter = authed.designs.router({
  list: authed.designs.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listDesigns(tx, tenant, input)),
  ),
  get: authed.designs.get.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.getDesign(tx, tenant, input.id)),
  ),
  create: authed.designs.create.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.createDesign(tx, tenant, input)),
  ),
  update: authed.designs.update.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.updateDesign(tx, tenant, input)),
  ),
  archive: authed.designs.archive.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.setDesignStatus(tx, tenant, input.id, "archived")),
  ),
  unarchive: authed.designs.unarchive.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.setDesignStatus(tx, tenant, input.id, "active")),
  ),
  // One QA turn per company (lease + allowance); over it, RATE_LIMITED at once with no imaging
  // call and no sleep (T-43-3, S-76). The lease is taken before the transaction opens.
  runQa: authed.designs.runQa.handler(async ({ input, context: { tenant } }) => {
    const calls = await withTenant(tenant.companyId, (tx) => svc.qaCallCount(tx, input.id));
    const turn = await takeQaTurn(tenant.companyId, calls);
    if (!turn.ok) throw rateLimited(retrySeconds(turn.retryAfterMs));
    try {
      return await withTenant(tenant.companyId, (tx) =>
        svc.runDesignQa(tx, tenant, input.id, {
          cleanAlpha: input.cleanAlpha,
          qaBusy: QA_MANUAL_BUSY,
        }),
      );
    } catch (err) {
      if (isImagingBusy(err)) throw rateLimited(retrySeconds(err.retryAfterMs ?? 5_000));
      throw err;
    } finally {
      await turn.release();
    }
  }),
  acceptQaWarning: authed.designs.acceptQaWarning.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.acceptQaWarning(tx, tenant, input)),
  ),
  unacceptQaWarning: authed.designs.unacceptQaWarning.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.unacceptQaWarning(tx, tenant, input)),
  ),
});

export const blanksRouter = authed.blanks.router({
  list: authed.blanks.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listBlanks(tx, tenant, input)),
  ),
  get: authed.blanks.get.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.getBlank(tx, tenant, input.id)),
  ),
  create: authed.blanks.create.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.createBlank(tx, tenant, input)),
  ),
  update: authed.blanks.update.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.updateBlank(tx, tenant, input)),
  ),
  archive: authed.blanks.archive.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.archiveBlank(tx, tenant, input.id)),
  ),
  bulkImport: authed.blanks.bulkImport.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.bulkImportBlanks(tx, tenant, input)),
  ),
  facets: authed.blanks.facets.handler(({ context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.blankFacets(tx, tenant)),
  ),
});

export const productsRouter = authed.products.router({
  list: authed.products.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listProducts(tx, tenant, input)),
  ),
  get: authed.products.get.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.getProduct(tx, tenant, input.id)),
  ),
  create: authed.products.create.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.createProduct(tx, tenant, input)),
  ),
  update: authed.products.update.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.updateProduct(tx, tenant, input)),
  ),
  archive: authed.products.archive.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.archiveProduct(tx, tenant, input.id)),
  ),
  mockup: authed.products.mockup.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.productMockup(tx, tenant, input)),
  ),
});
