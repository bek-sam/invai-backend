import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import { bulkApply, remapUnmapped } from "../orders/mapping";
import * as svc from "./service";
import * as sku from "./sku";
import { importCsv, startSync } from "./sync";

export const channelsRouter = authed.channels.router({
  list: authed.channels.list.handler(({ context: { tenant } }) =>
    withTenant(tenant.companyId, async (tx) => ({ items: await svc.listConnections(tx, tenant) })),
  ),
  get: authed.channels.get.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.getConnection(tx, tenant, input.id)),
  ),
  connect: authed.channels.connect.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.connect(tx, tenant, input)),
  ),
  update: authed.channels.update.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.updateConnection(tx, tenant, input)),
  ),
  disconnect: authed.channels.disconnect.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.disconnect(tx, tenant, input.id)),
  ),
  syncNow: authed.channels.syncNow.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => startSync(tx, tenant, input.id)),
  ),
  importCsv: authed.channels.importCsv.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => importCsv(tx, tenant, input)),
  ),
  imports: authed.channels.imports.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listImports(tx, tenant, input)),
  ),
  health: authed.channels.health.handler(({ context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.health(tx, tenant)),
  ),
});

export const skuRulesRouter = authed.skuRules.router({
  list: authed.skuRules.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => sku.listRules(tx, tenant, input)),
  ),
  get: authed.skuRules.get.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => sku.getRule(tx, tenant, input.id)),
  ),
  // A new or edited rule maps every unmapped item it now matches.
  create: authed.skuRules.create.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, async (tx) => {
      const rule = await sku.createRule(tx, tenant, input);
      await remapUnmapped(tx, tenant);
      return sku.getRule(tx, tenant, rule.id);
    }),
  ),
  update: authed.skuRules.update.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, async (tx) => {
      const rule = await sku.updateRule(tx, tenant, input);
      await remapUnmapped(tx, tenant);
      return sku.getRule(tx, tenant, rule.id);
    }),
  ),
  delete: authed.skuRules.delete.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => sku.deleteRule(tx, tenant, input.id)),
  ),
  test: authed.skuRules.test.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => sku.testRule(tx, tenant, input)),
  ),
  unmapped: authed.skuRules.unmapped.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => sku.unmapped(tx, tenant, input)),
  ),
  suggest: authed.skuRules.suggest.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => sku.suggest(tx, tenant, input)),
  ),
  bulkApply: authed.skuRules.bulkApply.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => bulkApply(tx, tenant, input)),
  ),
});
