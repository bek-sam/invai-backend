import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../db/client";
import { members, sessions } from "../db/schema";
import { env } from "../env";
import {
  createFloorSessionToken,
  issueStationToken,
  revokeFloorSession,
  revokeStationTokens,
} from "../modules/tenancy/floor-auth";
import { createCompany, createLocation, createStation, createUser } from "../test/fixtures";
import { app } from "./app";
import { createEvents, events } from "./events";
import { beginShutdown } from "./shutdown";

/**
 * /events auth (T-P6-2, B-31): no session in the query string, and a re-check every ping that
 * closes a revoked stream with `event: unauthorized`. A short ping interval stands in for 25 s.
 */
const PING = 60;
const fast = createEvents({ pingMs: PING });
const dbDown = createEvents({ pingMs: PING, probe: async () => false });

type Floor = { companyId: string; stationId: string; userId: string; token: string };

async function floorSession(): Promise<Floor> {
  const companyId = (await createCompany()).id;
  const location = await createLocation(companyId);
  const station = await createStation(companyId, location.id);
  const user = await createUser(companyId, "presser");
  const { tokenId } = await withTenant(companyId, (tx) =>
    issueStationToken(tx, { companyId, stationId: station.id, userId: null }),
  );
  const { token } = createFloorSessionToken({
    userId: user.id,
    companyId,
    stationId: station.id,
    stationTokenId: tokenId,
    role: "presser",
  });
  return { companyId, stationId: station.id, userId: user.id, token };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A reader over one SSE response that keeps what it has read so far. */
function sse(res: Response) {
  const body = res.body;
  if (!body) throw new Error("no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let ended = false;
  const tick = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));
  return {
    /** Read until `until(text)` holds, the stream ends, or the timeout passes. */
    async next(until: (text: string) => boolean = () => false, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (!ended && !until(text) && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), tick(Math.max(1, deadline - Date.now()))]);
        if (chunk === null) break;
        if (chunk.done) ended = true;
        else text += decoder.decode(chunk.value, { stream: true });
      }
      return { text, ended };
    },
    close: () => reader.cancel().catch(() => {}),
  };
}

const lastEvent = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("event: "))
    .at(-1);

const count = (text: string, event: string) =>
  text.split("\n").filter((l) => l === `event: ${event}`).length;

describe("/events auth", () => {
  let f: Floor;
  beforeAll(async () => {
    f = await floorSession();
  });

  it("refuses a floor session passed only in ?token= (no header, no cookie)", async () => {
    const res = await events.request(`/?token=${encodeURIComponent(f.token)}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("refuses ?token= through the mounted app route too", async () => {
    const res = await app.request(`/events?token=${encodeURIComponent(f.token)}`);
    expect(res.status).toBe(401);
  });

  it("streams for Authorization: Bearer <floor session>", async () => {
    const res = await events.request("/", { headers: bearer(f.token) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const r = sse(res);
    const { text } = await r.next((t) => t.includes("event: ping"));
    expect(text).toContain("event: ready");
    expect(text).toContain(f.companyId);
    await r.close();
  });

  it("keeps a still-valid session open and pinging across several re-checks", async () => {
    const res = await fast.request("/", { headers: bearer(f.token) });
    expect(res.status).toBe(200);
    const r = sse(res);
    const { text, ended } = await r.next((t) => count(t, "ping") >= 4);
    expect(count(text, "ping")).toBeGreaterThanOrEqual(4);
    expect(text).not.toContain("event: unauthorized");
    expect(ended).toBe(false);
    await r.close();
  });
});

/** Open a fast-pinging stream and wait until it is live (past `ready`). */
async function openLive(route: typeof fast, headers: Record<string, string>) {
  const res = await route.request("/", { headers });
  expect(res.status).toBe(200);
  const r = sse(res);
  await r.next((t) => t.includes("event: ping"));
  return r;
}

describe("/events closes revoked streams", () => {
  it("revoked station token: sends unauthorized, ends, and the reconnect gets 401", async () => {
    const s = await floorSession();
    const r = await openLive(fast, bearer(s.token));
    await withTenant(s.companyId, (tx) =>
      revokeStationTokens(tx, { companyId: s.companyId, stationId: s.stationId }),
    );
    const { text, ended } = await r.next();
    expect(ended).toBe(true);
    expect(lastEvent(text)).toBe("event: unauthorized");
    expect(text).not.toMatch(/^retry:/m);
    const again = await fast.request("/", { headers: bearer(s.token) });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "unauthorized" });
  });

  it("signed-out floor session: sends unauthorized and ends", async () => {
    const s = await floorSession();
    const r = await openLive(fast, bearer(s.token));
    await revokeFloorSession(s.token);
    const { text, ended } = await r.next();
    expect(ended).toBe(true);
    expect(lastEvent(text)).toBe("event: unauthorized");
  });

  it("deactivated member: sends unauthorized and ends", async () => {
    const s = await floorSession();
    const r = await openLive(fast, bearer(s.token));
    await withSystem((tx) =>
      tx
        .update(members)
        .set({ status: "deactivated" })
        .where(and(eq(members.userId, s.userId), eq(members.organizationId, s.companyId))),
    );
    const { text, ended } = await r.next();
    expect(ended).toBe(true);
    expect(lastEvent(text)).toBe("event: unauthorized");
  });

  it("database unreachable on re-check: retry hint, never unauthorized (ruling C1)", async () => {
    const s = await floorSession();
    const r = await openLive(dbDown, bearer(s.token));
    await revokeFloorSession(s.token); // the re-check fails, but the probe says the DB is down
    const { text, ended } = await r.next();
    expect(ended).toBe(true);
    expect(text).not.toContain("event: unauthorized");
    expect(lastEvent(text)).toBe("event: shutdown");
    expect(text).toMatch(/^retry: 5000$/m);
  });
});

describe("/events with a web cookie", () => {
  const post = (path: string, body: unknown, cookie?: string) =>
    app.request(`/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: env.WEB_ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .filter((c) => !/max-age=0/i.test(c))
      .map((c) => c.split(";")[0])
      .join("; ");

  async function webUser() {
    const companyId = (await createCompany()).id;
    const email = `sse-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
    const res = await post("/sign-up/email", { email, password: "correct horse 1", name: "Sse" });
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    const { user } = (await res.json()) as { user: { id: string } };
    await withSystem((tx) =>
      tx.insert(members).values({ organizationId: companyId, userId: user.id, role: "owner" }),
    );
    return { companyId, userId: user.id, cookie };
  }

  it("sign-out closes the stream with unauthorized", async () => {
    const u = await webUser();
    const r = await openLive(fast, { cookie: u.cookie });
    const signOut = await post("/sign-out", {}, u.cookie);
    expect(signOut.status).toBe(200);
    const { text, ended } = await r.next();
    expect(ended).toBe(true);
    expect(lastEvent(text)).toBe("event: unauthorized");
    const again = await fast.request("/", { headers: { cookie: u.cookie } });
    expect(again.status).toBe(401);
  });

  it("a re-check that resolves to another company closes the stream", async () => {
    const u = await webUser();
    const r = await openLive(fast, { cookie: u.cookie });
    const other = (await createCompany()).id;
    await withSystem(async (tx) => {
      await tx.insert(members).values({ organizationId: other, userId: u.userId, role: "owner" });
      await tx
        .update(sessions)
        .set({ activeOrganizationId: other })
        .where(eq(sessions.userId, u.userId));
    });
    const { text, ended } = await r.next();
    expect(ended).toBe(true);
    expect(text).toContain(u.companyId);
    expect(lastEvent(text)).toBe("event: unauthorized");
  });
});

describe("/events shutdown (T-12-2, unchanged)", () => {
  // Last in the file: beginShutdown flips a process-wide flag for good. Uses the real 25 s
  // interval, so the stream must wake on the shutdown signal, not on the timer.
  it("sends a shutdown retry hint and ends without waiting for the next ping", async () => {
    const s = await floorSession();
    const r = sse(await events.request("/", { headers: bearer(s.token) }));
    await r.next((t) => t.includes("event: ping"));
    beginShutdown();
    const { text, ended } = await r.next(undefined, 2_000);
    expect(ended).toBe(true);
    expect(lastEvent(text)).toBe("event: shutdown");
    expect(text).toMatch(/^retry: 1000$/m);
    expect(text).not.toContain("event: unauthorized");
  });
});
