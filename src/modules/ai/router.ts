import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import "./jobs";
import * as svc from "./service";

export const aiRouter = authed.ai.router({
  listings: {
    create: authed.ai.listings.create.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.createDrafts(tx, tenant, input)),
    ),
    list: authed.ai.listings.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listDrafts(tx, tenant, input)),
    ),
    get: authed.ai.listings.get.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getDraft(tx, tenant, input.id)),
    ),
    update: authed.ai.listings.update.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.updateDraft(tx, tenant, input.id, input.content)),
    ),
    // `acknowledgeRisk` is deprecated (kept in the contract input only so old clients still
    // typecheck): the trademark gate re-checks the draft's current `trademark` field live and has
    // no override, so the flag is ignored here (T-8-4).
    approve: authed.ai.listings.approve.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.approveDraft(tx, tenant, input.id)),
    ),
    reject: authed.ai.listings.reject.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.rejectDraft(tx, tenant, input.id, input.reason)),
    ),
    // T-8-4 (wave 8): compliance sign-off on a medium-risk draft.
    recordTrademarkReview: authed.ai.listings.recordTrademarkReview.handler(
      ({ input, context: { tenant } }) =>
        withTenant(tenant.companyId, (tx) =>
          svc.recordTrademarkReview(tx, tenant, input.id, input.note),
        ),
    ),
    publish: authed.ai.listings.publish.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) =>
        svc.publishDraft(tx, tenant, input.id, input.connectionId),
      ),
    ),
    publishStatus: authed.ai.listings.publishStatus.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.publishStatus(tx, tenant, input.id)),
    ),
    regenerate: authed.ai.listings.regenerate.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.regenerateDraft(tx, tenant, input.id, input.brief)),
    ),
  },
  assistant: {
    ask: authed.ai.assistant.ask.handler(({ input, context: { tenant } }) =>
      svc.ask(tenant, input),
    ),
    conversations: authed.ai.assistant.conversations.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listConversations(tx, tenant, input)),
    ),
    conversation: authed.ai.assistant.conversation.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getConversation(tx, tenant, input.id)),
    ),
  },
  credits: {
    balance: authed.ai.credits.balance.handler(({ context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.balance(tx, tenant)),
    ),
    ledger: authed.ai.credits.ledger.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.ledger(tx, tenant, input)),
    ),
  },
  // T-6-4 (wave 6 stub 5): one CSV row per variant, real SKUs.
  exportCsv: authed.ai.exportCsv.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.exportListingsCsv(tx, tenant, input)),
  ),
  validate: authed.ai.validate.handler(({ input }) => svc.validate(input.channel, input.content)),
  trademarkCheck: authed.ai.trademarkCheck.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.trademarkCheck(tx, tenant, input)),
  ),
});
