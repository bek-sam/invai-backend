import { describe, expect, it, vi } from "vitest";

/*
 * B-297 (ADR 0028): the sign-in after-hook fires the lock email without awaiting it. When that
 * promise rejects (a DB error inside `notifyLocked`), the failure is logged by kind only (no
 * email), the sign-in answer is the same 401, and nothing reaches the process
 * `unhandledRejection` handler (which would crash an API without one).
 */

const probe = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./account-lockout", async (orig) => ({
  ...(await orig<typeof import("./account-lockout")>()),
  notifyLocked: vi.fn(async (email: string) => {
    probe.calls++;
    // Shaped like a drizzle query error: its text quotes the params, the email among them.
    const err = new Error(`Failed query: select ... params: ${email.toLowerCase()}`);
    err.name = "DrizzleQueryError";
    Object.assign(err, { cause: { code: "57P01" } });
    throw err;
  }),
}));

const { app } = await import("../api/app");
const { env } = await import("../env");
const { errorKind } = await import("./account-lockout");

const post = (path: string, body: unknown) =>
  app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.WEB_ORIGIN },
    body: JSON.stringify(body),
  });

const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe("lock email failure (B-297)", () => {
  it("a rejecting notifyLocked is caught and logged without the email; the sign-in answer is unchanged", async () => {
    const email = `notify-${Date.now()}@test.local`;
    const signUp = await post("/sign-up/email", { email, password: "correct horse 1", name: "N" });
    expect(signUp.status).toBe(200);

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    const err = vi.spyOn(console, "error").mockImplementation(capture);
    const out = vi.spyOn(console, "log").mockImplementation(capture);
    try {
      const res = await post("/sign-in/email", { email, password: "wrong password 9" });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
      await vi.waitFor(() => expect(probe.calls).toBe(1));
      await vi.waitFor(() => expect(lines.some((l) => l.includes("lock email failed"))).toBe(true));
      await ticks(20);
      expect(unhandled).not.toHaveBeenCalled();
      const logged = lines.filter((l) => l.includes("lock email failed")).join("\n");
      expect(logged).toContain("DrizzleQueryError");
      expect(logged).toContain("57P01");
      expect(lines.join("\n").toLowerCase()).not.toContain(email.toLowerCase());
    } finally {
      process.off("unhandledRejection", unhandled);
      err.mockRestore();
      out.mockRestore();
    }
  });

  it("errorKind keeps the class and Postgres code, never the message", () => {
    const e = Object.assign(new Error("params: someone@example.com"), { code: "23505" });
    expect(errorKind(e)).toEqual({ error: "Error", code: "23505" });
    expect(errorKind("boom someone@example.com")).toEqual({ error: "string", code: null });
    expect(JSON.stringify(errorKind(e))).not.toContain("example.com");
  });
});
