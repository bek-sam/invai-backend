import { env } from "../../env";
import { isSampleWorkspace } from "../tenancy/demo-flag";

/**
 * The one mock visibility predicate (wave 18 hard fence, spec AC29): mock market sources are used
 * and shown only outside production, when mocks are explicitly allowed, or in a sample workspace.
 */
export async function mockSourcesAllowed(companyId: string): Promise<boolean> {
  if (!env.isProd || env.allowMocks) return true;
  return isSampleWorkspace(companyId);
}
