import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialsFromToken, exchangeShopifyCode, refreshShopifyToken } from "./auth";

afterEach(() => vi.unstubAllGlobals());

function stubToken(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

const tokenBody = {
  access_token: "shpat_new",
  scope: "read_orders,write_inventory",
  expires_in: 3600,
  refresh_token: "shprt_new",
  refresh_token_expires_in: 7776000,
};

describe("Shopify expiring offline tokens", () => {
  it("the code exchange asks for an expiring token and stores both expiries", async () => {
    const calls = stubToken(200, tokenBody);
    const before = Date.now();
    const creds = await exchangeShopifyCode("t31.myshopify.com", "code-1");
    expect(calls[0]?.url).toBe("https://t31.myshopify.com/admin/oauth/access_token");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ code: "code-1", expiring: 1 });
    expect(creds).toMatchObject({
      accessToken: "shpat_new",
      refreshToken: "shprt_new",
      scopes: ["read_orders", "write_inventory"],
    });
    const exp = new Date(creds.expiresAt ?? 0).getTime() - before;
    expect(exp).toBeGreaterThanOrEqual(3600_000 - 1000);
    expect(exp).toBeLessThanOrEqual(3600_000 + 1000);
    expect(creds.refreshTokenExpiresAt).not.toBeNull();
  });

  it("refresh posts a form with grant_type=refresh_token and returns the rotated pair", async () => {
    const calls = stubToken(200, tokenBody);
    const creds = await refreshShopifyToken("t31.myshopify.com", "shprt_old");
    const init = calls[0]?.init;
    expect((init?.headers as Record<string, string> | undefined)?.["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("shprt_old");
    expect(creds.refreshToken).toBe("shprt_new");
  });

  it("a refused refresh token is permanent; a server error is not", async () => {
    stubToken(401, { error: "invalid_grant" });
    await expect(refreshShopifyToken("t31.myshopify.com", "x")).rejects.toMatchObject({
      permanent: true,
    });
    stubToken(503, {});
    await expect(refreshShopifyToken("t31.myshopify.com", "x")).rejects.toMatchObject({
      permanent: false,
    });
  });

  it("a non-expiring token response keeps null expiries", () => {
    expect(credentialsFromToken({ access_token: "a", scope: "" })).toMatchObject({
      expiresAt: null,
      refreshToken: undefined,
    });
  });
});
