import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { channelConnections, DEFAULT_CONNECTION_SETTINGS, jobs } from "../../db/schema";
import * as channelsModule from "../../integrations/channels";
import { encryptJson } from "../../lib/crypto";
import { createCompany } from "../../test/fixtures";
import { refreshExpiringTokens } from "./service";
import { syncConnection } from "./sync";

/* B-343: connection and job error columns hold the scrubbed message head, never `params:`. */

vi.mock("../../integrations/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/channels")>();
  return { ...actual, getChannelAdapter: vi.fn(actual.getChannelAdapter) };
});

const VALUE = "Maria Perez 4410 Mesquite Lane";
const driverError = () => new Error(`Failed query: select 1\nparams: ${VALUE}`);

async function shopify(companyId: string, extra: Partial<typeof channelConnections.$inferInsert>) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId,
        channel: "shopify",
        name: "Shopify b343",
        status: "connected",
        mode: "api",
        provider: "mock",
        externalShopId: `b343-${crypto.randomUUID()}.myshopify.com`,
        settings: { ...DEFAULT_CONNECTION_SETTINGS },
        ...extra,
      })
      .returning(),
  );
  if (!row) throw new Error("insert failed");
  return row;
}

const reload = (companyId: string, id: string) =>
  withTenant(companyId, async (tx) => {
    const [r] = await tx.select().from(channelConnections).where(eq(channelConnections.id, id));
    return r;
  });

afterEach(() => vi.unstubAllGlobals());

describe("channel errors are stored scrubbed (B-343)", () => {
  it("a failed sync stores the head in connection.lastError and the job error", async () => {
    const co = (await createCompany()).id;
    const conn = await shopify(co, {});
    const [job] = await withSystem((tx) =>
      tx
        .insert(jobs)
        .values({ companyId: co, kind: "sync", status: "queued", input: { connectionId: conn.id } })
        .returning({ id: jobs.id }),
    );
    const real = await vi.mocked(channelsModule.getChannelAdapter)("shopify", "mock", conn);
    vi.mocked(channelsModule.getChannelAdapter).mockResolvedValueOnce({
      ...real,
      fetchOrders: async () => {
        throw driverError();
      },
    });
    await expect(syncConnection(co, conn.id, job?.id)).rejects.toThrow();
    const after = await reload(co, conn.id);
    expect(after?.lastError).toMatch(/^Failed query/);
    expect(after?.lastError).not.toContain(VALUE);
    const [row] = await withTenant(co, (tx) =>
      tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, job?.id as string)),
    );
    expect(row?.error ?? "").not.toContain(VALUE);
  });

  it("a failed token refresh stores the head in the connection's refreshError and lastError", async () => {
    const co = (await createCompany()).id;
    const conn = await shopify(co, {
      provider: "live",
      credentials: encryptJson({
        accessToken: "shpat_old",
        refreshToken: "shprt_old",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw driverError();
      }),
    );
    await refreshExpiringTokens();
    const after = await reload(co, conn.id);
    expect(after?.lastError).toContain("could not be renewed");
    expect(after?.lastError).not.toContain(VALUE);
    const { decryptJson } = await import("../../lib/crypto");
    const creds = decryptJson<{ refreshError?: { message: string } }>(after?.credentials as string);
    expect(creds.refreshError?.message).not.toContain(VALUE);
  });
});
