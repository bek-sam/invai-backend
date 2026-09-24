import { emailVendor } from "./email";
import { portalVendor } from "./portal";
import type { VendorAdapter } from "./types";

export { sendMail } from "./mailer";
export * from "./types";

export function vendorAdapter(delivery: "portal" | "email"): VendorAdapter {
  return delivery === "portal" ? portalVendor : emailVendor;
}
