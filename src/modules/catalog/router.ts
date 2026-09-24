import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
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
  runQa: authed.designs.runQa.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) =>
      svc.runDesignQa(tx, tenant, input.id, { cleanAlpha: input.cleanAlpha }),
    ),
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
