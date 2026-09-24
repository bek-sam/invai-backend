import { contract } from "@invai/contracts";
import { implement } from "@orpc/server";

export type Context = { companyId: string | null; userId: string | null };

const os = implement(contract).$context<Context>();

export const router = os.router({
  orders: {
    list: os.orders.list.handler(async () => ({ items: [], nextCursor: null })),
  },
  production: {
    buildSheets: os.production.buildSheets.handler(async () => ({ sheets: [] })),
    scan: os.production.scan.handler(async () => ({
      ok: false,
      reason: "not implemented",
      orderItemId: null,
    })),
  },
});
