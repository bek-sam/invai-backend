import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import * as svc from "./service";

export const filesRouter = authed.files.router({
  presignUpload: authed.files.presignUpload.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.presignUpload(tx, tenant, input)),
  ),
  downloadUrl: authed.files.downloadUrl.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.downloadUrl(tx, tenant, input)),
  ),
});
