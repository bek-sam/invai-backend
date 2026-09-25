import { eq } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { buyerPii } from "../../db/schema";

export type BuyerPiiValues = typeof buyerPii.$inferInsert & { companyId: string; orderId: string };
type PiiField =
  | "name"
  | "company"
  | "street1"
  | "street2"
  | "city"
  | "state"
  | "zip"
  | "country"
  | "phone";

/** The fields a channel re-import compares (the buyer changed the address on the channel). */
export const IMPORT_ADDRESS_FIELDS: PiiField[] = [
  "street1",
  "street2",
  "city",
  "state",
  "zip",
  "name",
];
/** Every ship-to field an office edit can change. */
export const ALL_ADDRESS_FIELDS: PiiField[] = [
  ...IMPORT_ADDRESS_FIELDS,
  "company",
  "country",
  "phone",
];

/**
 * Insert the order's buyer_pii row, or update it when one of `fields` differs from what's
 * stored. Shared by the channel import and `orders.updateAddress`. Returns what it did.
 */
export async function upsertBuyerPii(
  tx: Tx,
  next: BuyerPiiValues,
  fields: PiiField[] = IMPORT_ADDRESS_FIELDS,
): Promise<"inserted" | "updated" | null> {
  const [pii] = await tx.select().from(buyerPii).where(eq(buyerPii.orderId, next.orderId)).limit(1);
  if (!pii) {
    await tx.insert(buyerPii).values(next);
    return "inserted";
  }
  if (fields.some((f) => (pii[f] ?? null) !== (next[f] ?? null))) {
    await tx.update(buyerPii).set(next).where(eq(buyerPii.id, pii.id));
    return "updated";
  }
  return null;
}

/** The stored row, for callers that keep fields the edit doesn't carry (e.g. email). */
export async function buyerPiiRow(tx: Tx, orderId: string) {
  const [pii] = await tx.select().from(buyerPii).where(eq(buyerPii.orderId, orderId)).limit(1);
  return pii ?? null;
}
