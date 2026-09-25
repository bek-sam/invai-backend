/** What a vendor adapter needs to deliver one gang sheet. */
export type SheetDelivery = {
  /** The shop sending the sheet (a sample workspace never emails its vendor). */
  companyId: string;
  sheetId: string;
  sheetName: string;
  shopName: string;
  vendor: { name: string; email: string; vendorCompanyId: string | null };
  lengthIn: number;
  widthIn: number;
  transferCount: number;
  format: "png" | "pdf";
  note: string | null;
  /** Signed download links (email delivery) or null when the portal serves them. */
  links: { png: string | null; pdf: string | null; preview: string | null; expiresAt: string };
};

export interface VendorAdapter {
  kind: "portal" | "email";
  /** Deliver the sheet. The portal grant itself is written by the vendors service in the tx. */
  deliver(d: SheetDelivery): Promise<{ reference: string | null }>;
}
