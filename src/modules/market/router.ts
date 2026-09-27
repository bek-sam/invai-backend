import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

export const marketRouter = authed.market.router({
  ...stubRouter(authed.market, contract.market, ["market"]),
});
