import { escapeHtml, sendMail } from "../mailer";
import type { SheetDelivery, VendorAdapter } from "../types";

/** Email delivery: the vendor gets signed download links (valid 7 days) by SMTP. */
export const emailVendor: VendorAdapter = {
  kind: "email",
  async deliver(d: SheetDelivery) {
    const lines = [
      `${d.shopName} sent you a DTF gang sheet: ${d.sheetName}`,
      `${d.widthIn} x ${d.lengthIn.toFixed(1)} in, ${d.transferCount} transfers, ${d.format.toUpperCase()}`,
      d.note ? `Note: ${d.note}` : null,
      "",
      d.links.png ? `PNG: ${d.links.png}` : null,
      d.links.pdf ? `PDF: ${d.links.pdf}` : null,
      d.links.preview ? `Preview: ${d.links.preview}` : null,
      "",
      `Links expire ${d.links.expiresAt}.`,
    ].filter((l): l is string => l !== null);
    const link = (label: string, url: string | null) =>
      url ? `<li><a href="${escapeHtml(url)}">${label}</a></li>` : "";
    const html = `<p><b>${escapeHtml(d.shopName)}</b> sent you a DTF gang sheet: <b>${escapeHtml(d.sheetName)}</b></p>
<p>${d.widthIn} × ${d.lengthIn.toFixed(1)} in · ${d.transferCount} transfers · ${d.format.toUpperCase()}</p>
${d.note ? `<p>Note: ${escapeHtml(d.note)}</p>` : ""}
<ul>${link("Download PNG", d.links.png)}${link("Download PDF", d.links.pdf)}${link("Preview", d.links.preview)}</ul>
<p style="color:#666">Links expire ${escapeHtml(d.links.expiresAt)}.</p>`;
    const { messageId } = await sendMail({
      to: d.vendor.email,
      subject: `Gang sheet ${d.sheetName} from ${d.shopName}`,
      text: lines.join("\n"),
      html,
    });
    return { reference: messageId };
  },
};
