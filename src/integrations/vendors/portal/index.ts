import { publish } from "../../../lib/realtime";
import { escapeHtml, sendMail } from "../mailer";
import type { SheetDelivery, VendorAdapter } from "../types";

/**
 * Portal delivery: the vendors service writes the `vendor_access` grant in the transaction; this
 * notifies the vendor org (realtime to its portal plus a short heads-up email, no file links).
 */
export const portalVendor: VendorAdapter = {
  kind: "portal",
  async deliver(d: SheetDelivery) {
    if (d.vendor.vendorCompanyId) {
      await publish(d.vendor.vendorCompanyId, {
        type: "vendor.sheet_received",
        data: { sheetId: d.sheetId, shopName: d.shopName },
      });
    }
    const { messageId } = await sendMail({
      to: d.vendor.email,
      subject: `New gang sheet ${d.sheetName} from ${d.shopName}`,
      text: `${d.shopName} sent ${d.sheetName} (${d.transferCount} transfers, ${d.lengthIn.toFixed(1)} in). Open your InvAI vendor inbox to download it.${d.note ? `\nNote: ${d.note}` : ""}`,
      html: `<p><b>${escapeHtml(d.shopName)}</b> sent <b>${escapeHtml(d.sheetName)}</b> (${d.transferCount} transfers, ${d.lengthIn.toFixed(1)} in).</p><p>Open your InvAI vendor inbox to download it.</p>${d.note ? `<p>Note: ${escapeHtml(d.note)}</p>` : ""}`,
    });
    return { reference: messageId };
  },
};
