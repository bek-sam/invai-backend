import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/* Digest handlers (T-19-3). Day-1 stub: every procedure answers NOT_IMPLEMENTED until filled. */

export const digestRouter = authed.digest.router({
  ...stubRouter(authed.digest, contract.digest, ["digest"]),
});
