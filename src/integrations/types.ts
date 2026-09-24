import type { Channel, NormalizedOrder } from "@invai/contracts";

export type Connection = { id: string; companyId: string; channel: Channel; cursor: string | null };

export interface ChannelAdapter {
  channel: Channel;
  verifyWebhook(headers: Headers, body: string): Promise<boolean>;
  fetchOrders(conn: Connection): Promise<{ orders: NormalizedOrder[]; nextCursor: string | null }>;
  pushTracking(
    conn: Connection,
    orderId: string,
    carrier: string,
    trackingCode: string,
  ): Promise<void>;
  setAvailability(
    conn: Connection,
    updates: { channelSku: string; quantity: number }[],
  ): Promise<void>;
}

export interface CarrierAdapter {
  rate(shipment: unknown): Promise<{ service: string; amountCents: number }[]>;
  buyLabel(shipment: unknown, service: string): Promise<{ trackingCode: string; labelUrl: string }>;
}

export interface SupplierAdapter {
  stock(skus: string[]): Promise<{ sku: string; quantity: number }[]>;
  placeOrder(lines: { sku: string; quantity: number }[]): Promise<{ supplierOrderId: string }>;
}

export interface VendorAdapter {
  sendSheet(sheetId: string, fileUrl: string): Promise<void>;
}
