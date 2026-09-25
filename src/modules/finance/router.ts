import { authed } from "../../api/orpc";
import { afterCommit, withTenant } from "../../db/client";
import { recomputeJob } from "./jobs";
import * as svc from "./service";

export const financeRouter = authed.finance.router({
  costSettings: {
    get: authed.finance.costSettings.get.handler(({ context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getCostSettings(tx, tenant)),
    ),
    update: authed.finance.costSettings.update.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.updateCostSettings(tx, tenant, input)),
    ),
  },
  adSpend: {
    list: authed.finance.adSpend.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listAdSpend(tx, tenant, input)),
    ),
    create: authed.finance.adSpend.create.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.createAdSpend(tx, tenant, input)),
    ),
    update: authed.finance.adSpend.update.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.updateAdSpend(tx, tenant, input)),
    ),
    delete: authed.finance.adSpend.delete.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.deleteAdSpend(tx, tenant, input.id)),
    ),
    importCsv: authed.finance.adSpend.importCsv.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.importAdSpendCsv(tx, tenant, input.fileKey)),
    ),
  },
  profit: authed.finance.profit.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.getProfit(tx, tenant, input)),
  ),
  // T-6-3 (wave 6 stub 7): same filters as `profit`, so the export matches what's on screen.
  exportCsv: authed.finance.exportCsv.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.exportProfitCsv(tx, tenant, input)),
  ),
  orderProfit: authed.finance.orderProfit.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.orderProfit(tx, tenant, input.orderId)),
  ),
  recompute: authed.finance.recompute.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, async (tx) => {
      const job = await svc.createRecomputeJob(tx, tenant, input.period);
      afterCommit(tx, async () => {
        await recomputeJob.enqueue({
          companyId: tenant.companyId,
          from: job.from,
          to: job.to,
          jobRowId: job.jobId,
        });
      });
      return { jobId: job.jobId };
    }),
  ),
});
