import type { TenantContext } from "../../api/context";
import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import { isORPCError, ORPCError, unauthorized } from "../../lib/errors";
import { sendPreview } from "./deliver";
import * as svc from "./service";

/*
 * Digest handlers (T-19-3): one line each. The guard already enforced auth and the permission
 * from the contract meta (`finance.read` to read, `org.manage` for settings and the preview);
 * plan usage is added by the service only for `billing.read`. Digests are per person (views,
 * votes, clicks), so a session without a user (a station) is refused.
 */

function person(t: TenantContext) {
  if (!t.userId) throw unauthorized();
  return { ...t, userId: t.userId };
}

export const digestRouter = authed.digest.router({
  list: authed.digest.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listDigests(tx, person(tenant), input)),
  ),
  get: authed.digest.get.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.getDigest(tx, person(tenant), input)),
  ),
  latest: authed.digest.latest.handler(({ context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.latestDigest(tx, person(tenant))),
  ),
  feedback: authed.digest.feedback.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.recordFeedback(tx, person(tenant), input)),
  ),
  recordClick: authed.digest.recordClick.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.recordClick(tx, person(tenant), input)),
  ),
  settings: {
    get: authed.digest.settings.get.handler(({ context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getSettings(tx, tenant)),
    ),
    set: authed.digest.settings.set.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.setSettings(tx, tenant, input)),
    ),
    setRecipientEmail: authed.digest.settings.setRecipientEmail.handler(
      ({ input, context: { tenant } }) =>
        withTenant(tenant.companyId, (tx) => svc.setRecipientEmail(tx, tenant, input)),
    ),
  },
  sendPreview: authed.digest.sendPreview.handler(async ({ context }) => {
    const me = person(context.tenant);
    try {
      const out = await sendPreview(me.companyId, me.userId);
      if (!out)
        throw new ORPCError("NO_DIGEST", {
          status: 409,
          message: "Nothing to preview yet: the first digest builds next week",
        });
      return out;
    } catch (err) {
      const retry = isORPCError(err) && err.code === "RATE_LIMITED" ? err.data : null;
      if (retry && typeof retry === "object" && "retryAfterSec" in retry)
        context.resHeaders?.set("Retry-After", String(retry.retryAfterSec));
      throw err;
    }
  }),
});
