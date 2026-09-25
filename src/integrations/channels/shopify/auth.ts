import { env } from "../../../env";
import { upstream } from "../../../lib/errors";
import type { ChannelCredentials } from "../types";

/*
 * Expiring offline access tokens (required for new public apps since 2026-04-01, for all public
 * apps from 2027-01-01). The code exchange asks for `expiring=1`: the access token lasts 1 hour,
 * the refresh token 90 days, and every refresh returns a new pair (rotation), so both are stored
 * together, atomically, with their expiry.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
 */

type TokenResponse = {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

const tokenUrl = (shop: string) => `https://${shop}/admin/oauth/access_token`;

/** Token endpoint answer -> the credential fields we store (expiry as ISO timestamps). */
export function credentialsFromToken(json: TokenResponse, now = Date.now()): ChannelCredentials {
  if (!json.access_token) throw upstream("Shopify", "token response without an access token");
  const at = (seconds: number | undefined) =>
    typeof seconds === "number" && seconds > 0
      ? new Date(now + seconds * 1000).toISOString()
      : null;
  return {
    accessToken: json.access_token,
    ...(json.scope !== undefined ? { scopes: json.scope.split(",").filter(Boolean) } : {}),
    refreshToken: json.refresh_token,
    expiresAt: at(json.expires_in),
    refreshTokenExpiresAt: at(json.refresh_token_expires_in),
  };
}

export async function exchangeShopifyCode(shop: string, code: string) {
  const res = await fetch(tokenUrl(shop), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      code,
      expiring: 1,
    }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!res.ok) throw upstream("Shopify", `token exchange failed (${res.status})`);
  return credentialsFromToken((await res.json()) as TokenResponse);
}

/** `permanent`: Shopify refused the refresh token (the shop must reconnect); else retry later. */
export class ShopifyRefreshError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/** Exchange the refresh token for a new access token and a new (rotated) refresh token. */
export async function refreshShopifyToken(
  shop: string,
  refreshToken: string,
): Promise<ChannelCredentials> {
  let res: Response;
  try {
    res = await fetch(tokenUrl(shop), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: env.SHOPIFY_API_KEY ?? "",
        client_secret: env.SHOPIFY_API_SECRET ?? "",
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch (err) {
    throw new ShopifyRefreshError(err instanceof Error ? err.message : String(err), false);
  }
  if (res.status >= 400 && res.status < 500 && res.status !== 429)
    throw new ShopifyRefreshError(`refresh refused (${res.status})`, true);
  if (!res.ok) throw new ShopifyRefreshError(`refresh failed (${res.status})`, false);
  const creds = credentialsFromToken((await res.json()) as TokenResponse);
  if (!creds.refreshToken) throw new ShopifyRefreshError("refresh returned no refresh token", true);
  return creds;
}
