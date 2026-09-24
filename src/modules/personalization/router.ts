import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import * as svc from "./service";

const p = authed.personalization;

export const personalizationRouter = p.router({
  templates: {
    list: p.templates.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listTemplates(tx, tenant, input)),
    ),
    get: p.templates.get.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getTemplate(tx, tenant, input.id)),
    ),
    create: p.templates.create.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.createTemplate(tx, tenant, input)),
    ),
    update: p.templates.update.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.updateTemplate(tx, tenant, input)),
    ),
    delete: p.templates.delete.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.deleteTemplate(tx, tenant, input.id)),
    ),
    preview: p.templates.preview.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.previewTemplate(tx, tenant, input)),
    ),
  },
  artwork: {
    list: p.artwork.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listArtwork(tx, tenant, input)),
    ),
    get: p.artwork.get.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getArtwork(tx, tenant, input.orderItemId)),
    ),
    approve: p.artwork.approve.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.approveArtwork(tx, tenant, input.orderItemId)),
    ),
    update: p.artwork.update.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.updateArtworkValues(tx, tenant, input)),
    ),
    rerender: p.artwork.rerender.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.rerenderArtwork(tx, tenant, input.orderItemId)),
    ),
  },
});
