import { and, eq, inArray, lt, ne } from "drizzle-orm";
import { systemContext } from "../../api/context";
import { type Tx, withSystem, withTenant } from "../../db/client";
import {
  buyerPii,
  channelConnections,
  orderItems,
  orders,
  PRIVACY_REQUEST_DUE_MS,
  type PrivacyCounts,
  privacyRequests,
} from "../../db/schema";
import type { PrivacyWebhookRequest } from "../../integrations/channels/types";
import { audit } from "../../lib/audit";
import { logger } from "../../lib/log";
import { deleteObject } from "../../lib/s3";

const log = logger("privacy");

/*
 * Channel privacy requests (Shopify compliance webhooks, B-06; playbook
 * `privacy-request-handling`). InvAI is the shop's processor for buyer data.
 * - customers/redact: that customer's orders from that store lose their buyer PII before the
 *   webhook is answered: `buyer_pii` rows deleted, buyer note and buyer reference cleared,
 *   personalization answers cleared, the encrypted raw payload deleted from storage. Non-personal
 *   order facts (ids, SKUs, amounts, dates, tracking) stay for the shop's accounting.
 * - shop/redact (48 h after uninstall): the same for every order from that store.
 * - customers/data_request: an open request for the owner to answer within 30 days.
 * Every request is recorded in `privacy_requests` per company, without PII. Idempotent: a
 * redelivery redacts nothing new and records nothing twice.
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 */

export type PrivacyHandled = {
  handled: boolean;
  reason?: string;
  companyIds: string[];
  counts: PrivacyCounts;
};

const zero = (): PrivacyCounts => ({
  orders: 0,
  buyerPii: 0,
  rawPayloads: 0,
  personalizedItems: 0,
});

function add(a: PrivacyCounts, b: PrivacyCounts): PrivacyCounts {
  return {
    orders: a.orders + b.orders,
    buyerPii: a.buyerPii + b.buyerPii,
    rawPayloads: a.rawPayloads + b.rawPayloads,
    personalizedItems: a.personalizedItems + b.personalizedItems,
  };
}

/** The orders a request covers in one company: only orders imported from that store's connections. */
async function targetOrders(tx: Tx, connectionIds: string[], orderIds: string[] | "all") {
  if (orderIds !== "all" && orderIds.length === 0) return [];
  return tx
    .select({ id: orders.id, rawPayloadKey: orders.rawPayloadKey })
    .from(orders)
    .where(
      and(
        inArray(orders.connectionId, connectionIds),
        orderIds === "all" ? undefined : inArray(orders.channelOrderId, orderIds),
      ),
    );
}

/** Remove buyer PII from these orders (inside the tenant transaction). */
async function redactOrders(tx: Tx, ids: string[]): Promise<Omit<PrivacyCounts, "rawPayloads">> {
  if (ids.length === 0) return { orders: 0, buyerPii: 0, personalizedItems: 0 };
  const pii = await tx
    .delete(buyerPii)
    .where(inArray(buyerPii.orderId, ids))
    .returning({ id: buyerPii.id });
  await tx
    .update(orders)
    .set({ buyerNote: null, buyerRef: null, rawPayloadKey: null })
    .where(inArray(orders.id, ids));
  const items = await tx
    .select({ id: orderItems.id, personalization: orderItems.personalization })
    .from(orderItems)
    .where(inArray(orderItems.orderId, ids));
  let personalizedItems = 0;
  for (const item of items) {
    const answers = item.personalization ?? [];
    if (!answers.some((p) => p.answer !== null || p.fileUrl !== null)) continue;
    await tx
      .update(orderItems)
      .set({ personalization: answers.map((p) => ({ ...p, answer: null, fileUrl: null })) })
      .where(eq(orderItems.id, item.id));
    personalizedItems++;
  }
  return { orders: ids.length, buyerPii: pii.length, personalizedItems };
}

/**
 * Handle one verified compliance delivery. Routes by the shop domain from the signed body to
 * every company that has (or had) that store connected; a store we never connected is logged and
 * acknowledged. Throws on a storage or database failure so the delivery is retried.
 */
export async function handlePrivacyRequest(input: {
  channel: "shopify";
  shopDomain: string;
  deliveryId: string;
  request: PrivacyWebhookRequest;
}): Promise<PrivacyHandled> {
  const { channel, shopDomain, deliveryId, request } = input;
  const conns = await withSystem((tx) =>
    tx
      .select({ id: channelConnections.id, companyId: channelConnections.companyId })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.channel, channel),
          eq(channelConnections.externalShopId, shopDomain),
          // Disconnected stores count: shop/redact arrives 48 h after uninstall.
          ne(channelConnections.status, "pending"),
        ),
      ),
  );
  if (conns.length === 0) {
    log.info("privacy request for a store we never connected", { topic: request.topic });
    return {
      handled: false,
      reason: "no connection for this store",
      companyIds: [],
      counts: zero(),
    };
  }
  const byCompany = new Map<string, string[]>();
  for (const c of conns) byCompany.set(c.companyId, [...(byCompany.get(c.companyId) ?? []), c.id]);

  let total = zero();
  const receivedAt = new Date();
  for (const [companyId, connectionIds] of byCompany) {
    const redact = request.topic !== "customers/data_request";
    let counts = zero();
    if (redact) {
      const scope = request.topic === "shop/redact" ? "all" : request.channelOrderIds;
      const found = await withTenant(companyId, (tx) => targetOrders(tx, connectionIds, scope));
      // Storage first: if a delete fails the webhook is retried while the keys are still known.
      const keys = found.map((o) => o.rawPayloadKey).filter((k): k is string => !!k);
      for (const key of keys) await deleteObject(key);
      counts = await withTenant(companyId, async (tx) => {
        const res = await redactOrders(
          tx,
          found.map((o) => o.id),
        );
        const c = { ...res, rawPayloads: keys.length };
        await audit(tx, {
          companyId,
          actor: systemContext(companyId).actor,
          action: "privacy.redacted",
          entityType: "channel_connection",
          entityId: connectionIds[0] ?? null,
          summary: `Shopify ${request.topic}: buyer data removed from ${c.orders} order(s)`,
          data: { deliveryId, ...c },
        });
        return c;
      });
    } else {
      await withTenant(companyId, (tx) =>
        audit(tx, {
          companyId,
          actor: systemContext(companyId).actor,
          action: "privacy.requested",
          entityType: "channel_connection",
          entityId: connectionIds[0] ?? null,
          summary: `Shopify customer data request for ${request.channelOrderIds.length} order(s); answer the store owner within 30 days`,
          data: { deliveryId, channelRequestId: request.channelRequestId },
        }),
      );
      log.warn("privacy data request received; the owner must answer it", {
        companyId,
        channelRequestId: request.channelRequestId,
      });
    }
    await withSystem((tx) =>
      tx
        .insert(privacyRequests)
        .values({
          companyId,
          connectionId: connectionIds[0] ?? null,
          channel,
          topic: request.topic,
          deliveryId,
          externalShopId: shopDomain,
          channelCustomerId: request.channelCustomerId,
          channelRequestId: request.channelRequestId,
          channelOrderIds: request.channelOrderIds,
          status: redact ? "completed" : "open",
          receivedAt,
          dueAt: new Date(receivedAt.getTime() + PRIVACY_REQUEST_DUE_MS),
          completedAt: redact ? new Date() : null,
          counts,
        })
        .onConflictDoNothing(),
    );
    total = add(total, counts);
  }
  log.info("privacy request handled", {
    topic: request.topic,
    companies: byCompany.size,
    ...total,
  });
  return { handled: true, companyIds: [...byCompany.keys()], counts: total };
}

/** Open requests older than 20 days (10 days before Shopify's 30-day deadline): warned daily. */
export const PRIVACY_WARN_AFTER_MS = 20 * 86400_000;

export async function warnOverduePrivacyRequests(now = new Date()) {
  const late = await withSystem((tx) =>
    tx
      .select({
        id: privacyRequests.id,
        companyId: privacyRequests.companyId,
        topic: privacyRequests.topic,
        dueAt: privacyRequests.dueAt,
      })
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.status, "open"),
          lt(privacyRequests.receivedAt, new Date(now.getTime() - PRIVACY_WARN_AFTER_MS)),
        ),
      ),
  );
  for (const r of late)
    log.error("privacy request still open after 20 days", {
      requestId: r.id,
      companyId: r.companyId,
      topic: r.topic,
      dueAt: r.dueAt.toISOString(),
    });
  return { overdue: late.length };
}
