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
    approve: authed.ai.listings.approve.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) =>
        svc.approveDraft(tx, tenant, input.id, input.acknowledgeRisk),
      ),
    ),
    reject: authed.ai.listings.reject.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.rejectDraft(tx, tenant, input.id, input.reason)),
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
  validate: authed.ai.validate.handler(({ input }) => svc.validate(input.channel, input.content)),
  trademarkCheck: authed.ai.trademarkCheck.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.trademarkCheck(tx, tenant, input)),
  ),
});
