import { upstream } from "../../../lib/errors";
import type { ChannelConn } from "../types";
import { SHOPIFY_API_VERSION } from "./common";

type GqlResponse<T> = {
  data?: T;
  errors?: { message: string }[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number } } };
};

export async function shopifyGraphql<T>(
  conn: Pick<ChannelConn, "externalShopId" | "credentials">,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const shop = conn.externalShopId;
  const token = conn.credentials?.accessToken;
  if (!shop || !token) throw upstream("Shopify", "connection has no access token; reconnect");
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    }).catch((err) => {
      throw upstream("Shopify", err instanceof Error ? err.message : String(err));
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (res.status === 401 || res.status === 403)
      throw upstream("Shopify", `access denied (${res.status}); reconnect the store`);
    const json = (await res.json()) as GqlResponse<T>;
    if (json.errors?.length) {
      const throttled = json.errors.some((e) => /throttled/i.test(e.message));
      if (throttled && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw upstream("Shopify", json.errors.map((e) => e.message).join("; "));
    }
    if (!json.data) throw upstream("Shopify", `empty response (${res.status})`);
    return json.data;
  }
  throw upstream("Shopify", "rate limited");
}
