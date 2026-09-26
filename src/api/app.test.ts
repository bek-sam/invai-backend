import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DISABLED_AUTH_PATHS } from "../auth";
import { db } from "../db/client";
import { companies } from "../db/schema";
import { env } from "../env";
import { app } from "./app";

const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: env.WEB_ORIGIN, ...extra },
  body: JSON.stringify(body),
});

async function signUp() {
  const email = `sec-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const res = await app.request(
    "/api/auth/sign-up/email",
    json({ email, password: "correct horse 1", name: "Sec Test" }),
  );
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { email, cookie };
}

describe("HTTP surface", () => {
  it("sends security headers and CORS only for the web and floor origins", async () => {
    const res = await app.request("/health", { headers: { origin: env.WEB_ORIGIN } });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
    if (env.isProd) {
      expect(res.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains",
      );
    }
    expect(res.headers.get("access-control-allow-origin")).toBe(env.WEB_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    const floor = await app.request("/health", { headers: { origin: env.FLOOR_ORIGIN } });
    expect(floor.headers.get("access-control-allow-origin")).toBe(env.FLOOR_ORIGIN);
    const evil = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects oversized request bodies", async () => {
    const res = await app.request("/webhooks/shopify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(6 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it("Better Auth org endpoints that bypass team rules are disabled", async () => {
    const { cookie } = await signUp();
    for (const path of [
      "/organization/update",
      "/organization/update-member-role",
      "/organization/remove-member",
      "/organization/invite-member",
      "/organization/delete",
    ]) {
      expect(DISABLED_AUTH_PATHS).toContain(path);
      const res = await app.request(`/api/auth${path}`, json({}, { cookie }));
      expect(res.status, path).toBe(404);
    }
  });

  it("sign-up cannot choose the plan or org type", async () => {
    const { cookie } = await signUp();
    const res = await app.request(
      "/api/auth/organization/create",
      json(
        {
          name: "Free Enterprise",
          slug: `free-ent-${Date.now()}`,
          plan: "enterprise",
          type: "vendor",
        },
        { cookie },
      ),
    );
    const body = (await res.json()) as { id?: string };
    if (res.status === 200 && body.id) {
      const [row] = await db.select().from(companies).where(eq(companies.id, body.id));
      expect(row?.plan).toBe("trial");
      expect(row?.type).toBe("shop");
    } else {
      // Better Auth may refuse unknown input fields outright; either way nothing escalates.
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
