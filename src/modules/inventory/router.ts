import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import * as svc from "./service";

const t = authed.inventory;

export const inventoryRouter = t.router({
  stock: {
    list: t.stock.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listStock(tx, tenant, input)),
    ),
    get: t.stock.get.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getStock(tx, tenant, input)),
    ),
    setReorderPoint: t.stock.setReorderPoint.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.setReorderPoint(tx, tenant, input)),
    ),
  },
  movements: {
    list: t.movements.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listMovements(tx, tenant, input)),
    ),
  },
  purchaseOrders: {
    list: t.purchaseOrders.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listPos(tx, tenant, input)),
    ),
    get: t.purchaseOrders.get.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getPo(tx, tenant, input.id)),
    ),
    create: t.purchaseOrders.create.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.createPo(tx, tenant, input)),
    ),
    update: t.purchaseOrders.update.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.updatePo(tx, tenant, input)),
    ),
    submit: t.purchaseOrders.submit.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.submitPo(tx, tenant, input.id)),
    ),
    receive: t.purchaseOrders.receive.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.receivePo(tx, tenant, input)),
    ),
    cancel: t.purchaseOrders.cancel.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.cancelPo(tx, tenant, input.id)),
    ),
  },
  suppliers: {
    list: t.suppliers.list.handler(({ context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listSuppliers(tx, tenant)),
    ),
    stock: t.suppliers.stock.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.suppliersStock(tx, tenant, input.blankVariantIds)),
    ),
  },
  settings: {
    get: t.settings.get.handler(({ context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getSettings(tx, tenant)),
    ),
    update: t.settings.update.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.updateSettings(tx, tenant, input)),
    ),
  },
  adjust: t.adjust.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.adjust(tx, tenant, input)),
  ),
  count: t.count.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.count(tx, tenant, input)),
  ),
  reorderSuggestions: t.reorderSuggestions.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.reorderSuggestions(tx, tenant, input)),
  ),
  createPoFromSuggestion: t.createPoFromSuggestion.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.createPoFromSuggestion(tx, tenant, input)),
  ),
});
