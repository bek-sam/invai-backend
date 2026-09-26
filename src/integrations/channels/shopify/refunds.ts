import type { ChannelConn, ChannelRefund } from "../types";
import { shopifyGraphql } from "./client";
import { cents } from "./common";

/*
 * T-7-2: refunds after the sale, from the order's `refunds` (Admin GraphQL 2026-07).
 * https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Refund
 * Read only for orders whose financial status is REFUNDED or PARTIALLY_REFUNDED, one small
 * query per such order, so the order poll's cost stays as it was for every other order.
 * - Line refunds: `subtotalSet` (before tax: sales tax refunded is not lost revenue).
 *   `restockType: CANCEL` lines are units removed before fulfilment; import already cancels
 *   those units and books them, so they are skipped here.
 * - Shipping refunds: `refundShippingLines.subtotalAmountSet` (before tax), order-level.
 */

const REFUNDS_COST = 120;

const REFUNDS_QUERY = /* GraphQL */ `
  query OrderRefunds($id: ID!) {
    order(id: $id) {
      refunds(first: 20) {
        id
        createdAt
        note
        refundLineItems(first: 50) {
          nodes {
            lineItem { id }
            quantity
            restockType
            subtotalSet { shopMoney { amount } }
          }
        }
        refundShippingLines(first: 5) {
          nodes { subtotalAmountSet { shopMoney { amount } } }
        }
      }
    }
  }
`;

type Money = { shopMoney: { amount: string } };

export type GqlRefund = {
  id: string;
  createdAt: string;
  note: string | null;
  refundLineItems: {
    nodes: {
      lineItem: { id: string };
      quantity: number;
      restockType: string;
      subtotalSet: Money;
    }[];
  };
  refundShippingLines?: { nodes: { subtotalAmountSet: Money }[] } | null;
};

const gid = (id: string) => id.split("/").pop() ?? id;

/** The statuses whose orders carry refunds worth reading. */
export function hasRefunds(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "refunded" || s === "partially_refunded";
}

export function gqlRefundsToChannel(channelOrderId: string, refunds: GqlRefund[]): ChannelRefund[] {
  const out: ChannelRefund[] = [];
  for (const r of refunds) {
    const refundId = gid(r.id);
    for (const li of r.refundLineItems.nodes) {
      if (li.restockType === "CANCEL") continue;
      const amount = cents(li.subtotalSet?.shopMoney.amount);
      if (amount <= 0) continue;
      const lineId = gid(li.lineItem.id);
      out.push({
        channelOrderId,
        channelRefundId: `${refundId}:${lineId}`,
        channelLineId: lineId,
        quantity: li.quantity,
        amountCents: amount,
        refundedAt: new Date(r.createdAt).toISOString(),
        note: r.note || null,
      });
    }
    const shipping = (r.refundShippingLines?.nodes ?? []).reduce(
      (a, s) => a + cents(s.subtotalAmountSet?.shopMoney.amount),
      0,
    );
    if (shipping > 0)
      out.push({
        channelOrderId,
        channelRefundId: `${refundId}:shipping`,
        channelLineId: null,
        quantity: 1,
        amountCents: shipping,
        refundedAt: new Date(r.createdAt).toISOString(),
        note: r.note || null,
      });
  }
  return out;
}

export async function fetchOrderRefunds(
  conn: ChannelConn,
  orderGid: string,
  channelOrderId: string,
): Promise<ChannelRefund[]> {
  const data = await shopifyGraphql<{ order: { refunds: GqlRefund[] } | null }>(
    conn,
    REFUNDS_QUERY,
    { id: orderGid },
    { cost: REFUNDS_COST },
  );
  return gqlRefundsToChannel(channelOrderId, data.order?.refunds ?? []);
}
