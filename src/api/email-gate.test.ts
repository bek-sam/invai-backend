import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

/*
 * EMAIL_NOT_VERIFIED (T-2-3): the procedures that move money (label buys, Stripe checkout and
 * portal) refuse a user or floor session whose email isn't verified. Everything else, including
 * connecting a channel, works unverified.
 */

vi.mock("../integrations/vendors/mailer", async (orig) => ({
  ...(await orig<typeof import("../integrations/vendors/mailer")>()),
  sendMail: vi.fn(async () => ({ messageId: "<test>" })),
}));

const { CONTRACT_VERSION } = await import("@invai/contracts");
const { app } = await import("./app");
const { anonymousContext, permissionsFor } = await import("./context");
type Context = import("./context").Context;
const { EMAIL_VERIFIED_PROCEDURES } = await import("./orpc");
const { router } = await import("./router");
const { db } = await import("../db/client");
const { users } = await import("../db/schema");
const { env } = await import("../env");
const { createCompany, createUser } = await import("../test/fixtures");

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  if (!node) throw new Error(`no procedure ${path}`);
  return node as AnyProcedure;
}
async function codeOf(path: string, context: Context): Promise<string> {
  try {
    // The HTTP handler passes the path; the gate keys on it.
    await call(procedureAt(path), undefined as never, { context, path: path.split(".") });
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe("EMAIL_NOT_VERIFIED gate", () => {
  let companyId: string;
  let userId: string;
  const session = (over: Partial<Context>): Context => ({
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: userId, name: "x", email: "x@test.local" },
    companyId,
    orgType: "shop",
    role: "owner",
    permissions: permissionsFor("owner"),
    ...over,
  });

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    userId = (await createUser(companyId, "owner", { emailVerified: false })).id;
  });

  it("covers label buys and Stripe checkout and portal, and nothing else", () => {
    expect([...EMAIL_VERIFIED_PROCEDURES].sort()).toEqual([
      "billing.checkout",
      "billing.portal",
      "shipping.batchBuy",
      "shipping.buy",
    ]);
    for (const path of EMAIL_VERIFIED_PROCEDURES) expect(() => procedureAt(path)).not.toThrow();
  });

  it("an unverified owner gets EMAIL_NOT_VERIFIED on every paid action", async () => {
    for (const path of EMAIL_VERIFIED_PROCEDURES) {
      expect(await codeOf(path, session({ emailVerified: false })), path).toBe(
        "EMAIL_NOT_VERIFIED",
      );
    }
  });

  it("a verified owner gets past the gate", async () => {
    for (const path of EMAIL_VERIFIED_PROCEDURES) {
      expect(await codeOf(path, session({ emailVerified: true })), path).not.toBe(
        "EMAIL_NOT_VERIFIED",
      );
    }
  });

  it("connecting a channel, importing a CSV and rating a label don't need a verified email", async () => {
    for (const path of [
      "channels.connect",
      "channels.importCsv",
      "shipping.rates",
      "billing.get",
    ]) {
      const code = await codeOf(path, session({ emailVerified: false }));
      expect(code, path).not.toBe("EMAIL_NOT_VERIFIED");
      expect(code, path).not.toBe("FORBIDDEN");
    }
  });

  it("the permission check comes first: office still gets FORBIDDEN on checkout", async () => {
    const office = session({ role: "office", permissions: permissionsFor("office") });
    expect(await codeOf("billing.checkout", { ...office, emailVerified: false })).toBe("FORBIDDEN");
  });

  it("floor sessions: an unverified PIN user can't buy a label, a verified one can", async () => {
    const floor = (emailVerified: boolean) =>
      session({
        sessionKind: "floor",
        // A floor tablet sends its contract version (T-13-1), or the guard answers CLIENT_TOO_OLD.
        headers: new Headers({ "x-contract-version": CONTRACT_VERSION }),
        role: "packer",
        permissions: permissionsFor("packer"),
        emailVerified,
      });
    expect(await codeOf("shipping.buy", floor(false))).toBe("EMAIL_NOT_VERIFIED");
    expect(await codeOf("shipping.buy", floor(true))).not.toBe("EMAIL_NOT_VERIFIED");
  });

  it("over HTTP: a new owner can connect a channel, can't check out until the email is verified", async () => {
    const email = `gate-${Date.now()}@test.local`;
    const headers = { "content-type": "application/json", origin: env.WEB_ORIGIN };
    const signUp = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password: "correct horse 1", name: "Gate" }),
    });
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const org = await app.request("/api/auth/organization/create", {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify({ name: "Gate Shop", slug: `gate-${Date.now()}` }),
    });
    expect(org.status).toBe(200);
    const rpc = (path: string, body: unknown) =>
      app.request(`/api/v1${path}`, {
        method: "POST",
        headers: { ...headers, cookie },
        body: JSON.stringify(body),
      });

    const blocked = await rpc("/billing/checkout", { plan: "pro" });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    // Shopify OAuth start (mock provider locally): works before the email is verified.
    const connect = await rpc("/channels/connect", {
      channel: "shopify",
      shopDomain: `gate-${Date.now()}.myshopify.com`,
    });
    expect(connect.status, await connect.clone().text()).toBe(200);

    await db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
    const after = await rpc("/billing/checkout", { plan: "pro" });
    expect((await after.json()) as { code?: string }).not.toMatchObject({
      code: "EMAIL_NOT_VERIFIED",
    });
  });
});
