import { logger } from "../../../lib/log";
import type { ChannelConn, ChannelDisconnectResult, WebhookSubscriptionState } from "../types";
import { shopifyGraphql } from "./client";
import { SHOPIFY_WEBHOOK_TOPICS } from "./common";

const log = logger("channels.shopify.subscriptions");

/*
 * Shop-scoped webhook subscriptions (Admin GraphQL 2026-07). Shopify deletes API-created
 * subscriptions after repeated delivery failures within 24 h, so they are re-listed and recreated
 * on install and by a daily check; any topic that can't be subscribed is reported and the
 * connection shows as degraded in `channels.health`. The compliance topics are app-scoped
 * (`shopify.app.toml`), not created here.
 * - https://shopify.dev/docs/api/admin-graphql/latest/queries/webhookSubscriptions
 * - https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionCreate
 * - https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionDelete
 * - https://shopify.dev/docs/api/admin-graphql/latest/mutations/appUninstall
 * - https://shopify.dev/docs/apps/build/webhooks/troubleshoot
 */

const LIST = /* GraphQL */ `
  query Subscriptions($uri: String) {
    webhookSubscriptions(first: 50, uri: $uri) { nodes { id topic uri } }
  }
`;

const CREATE = /* GraphQL */ `
  mutation WebhookCreate($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

const DELETE = /* GraphQL */ `
  mutation WebhookDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

/** The app removes itself from the store: Shopify revokes its access token. */
const UNINSTALL = /* GraphQL */ `
  mutation AppUninstall {
    appUninstall {
      app { id }
      userErrors { field message }
    }
  }
`;

type Sub = { id: string; topic: string; uri: string };
type UserErrors = { userErrors: { message: string }[] };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Make sure every order topic is subscribed to `uri`; report the ones that aren't. */
export async function ensureShopifyWebhooks(
  conn: Pick<ChannelConn, "id" | "externalShopId" | "credentials">,
  uri: string,
): Promise<WebhookSubscriptionState> {
  const checkedAt = new Date().toISOString();
  let existing: Sub[];
  try {
    const data = await shopifyGraphql<{ webhookSubscriptions: { nodes: Sub[] } }>(conn, LIST, {
      uri,
    });
    existing = data.webhookSubscriptions.nodes.filter((s) => s.uri === uri);
  } catch (err) {
    return {
      checkedAt,
      subscriptionIds: [],
      failures: [{ topic: "*", message: `could not list subscriptions: ${errText(err)}` }],
    };
  }
  const ids = existing.map((s) => s.id);
  const failures: WebhookSubscriptionState["failures"] = [];
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    if (existing.some((s) => s.topic === topic)) continue;
    try {
      const res = await shopifyGraphql<{
        webhookSubscriptionCreate: UserErrors & { webhookSubscription: { id: string } | null };
      }>(conn, CREATE, { topic, sub: { uri, format: "JSON" } });
      const created = res.webhookSubscriptionCreate;
      if (created.userErrors.length || !created.webhookSubscription)
        failures.push({
          topic,
          message: created.userErrors.map((e) => e.message).join("; ") || "not created",
        });
      else ids.push(created.webhookSubscription.id);
    } catch (err) {
      failures.push({ topic, message: errText(err) });
    }
  }
  if (failures.length)
    log.warn("webhook subscriptions failed", { connectionId: conn.id, failures });
  return { checkedAt, subscriptionIds: ids, failures };
}

/**
 * Disconnect on Shopify's side: delete our subscriptions (the stored ids plus any still pointing
 * at `uri`), then uninstall the app, which revokes the access token. Never throws; what failed is
 * in `errors` so the caller can record it.
 */
export async function disconnectShopify(
  conn: Pick<ChannelConn, "id" | "externalShopId" | "credentials">,
  uri: string,
): Promise<ChannelDisconnectResult> {
  const errors: string[] = [];
  const ids = new Set(conn.credentials?.webhooks?.subscriptionIds ?? []);
  try {
    const data = await shopifyGraphql<{ webhookSubscriptions: { nodes: Sub[] } }>(conn, LIST, {
      uri,
    });
    for (const s of data.webhookSubscriptions.nodes) if (s.uri === uri) ids.add(s.id);
  } catch (err) {
    errors.push(`list subscriptions: ${errText(err)}`);
  }
  let unsubscribed = 0;
  for (const id of ids) {
    try {
      const res = await shopifyGraphql<{ webhookSubscriptionDelete: UserErrors }>(conn, DELETE, {
        id,
      });
      if (res.webhookSubscriptionDelete.userErrors.length)
        errors.push(res.webhookSubscriptionDelete.userErrors.map((e) => e.message).join("; "));
      else unsubscribed++;
    } catch (err) {
      errors.push(`delete subscription: ${errText(err)}`);
    }
  }
  let uninstalled = false;
  try {
    const res = await shopifyGraphql<{ appUninstall: UserErrors }>(conn, UNINSTALL);
    if (res.appUninstall.userErrors.length)
      errors.push(res.appUninstall.userErrors.map((e) => e.message).join("; "));
    else uninstalled = true;
  } catch (err) {
    errors.push(`uninstall: ${errText(err)}`);
  }
  return { unsubscribed, uninstalled, errors };
}
