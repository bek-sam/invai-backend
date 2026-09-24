import { REALTIME_SSE_PATH } from "@invai/contracts";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import type { StandardHandleResult } from "@orpc/server/standard";
import { experimental_ZodSmartCoercionPlugin } from "@orpc/zod/zod4";
import { sql } from "drizzle-orm";
import { type Context, Hono, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { auth } from "../auth";
import { db } from "../db/client";
import { env } from "../env";
import { imaging } from "../integrations/imaging/client";
import { isORPCError } from "../lib/errors";
import { errorData, logger } from "../lib/log";
import { redis } from "../lib/queues";
import { s3Healthy } from "../lib/s3";
import { buildContext } from "./context";
import { events } from "./events";
import { router } from "./router";
import { webhooks } from "./webhooks";
import "../modules/jobs";

const log = logger("api");

const logUnexpected = async (options: { next: () => Promise<StandardHandleResult> }) => {
  try {
    return await options.next();
  } catch (err) {
    if (!(isORPCError(err) && err.status < 500))
      log.error("unhandled procedure error", errorData(err));
    throw err;
  }
};

/** Apps talk RPC at /rpc; the same procedures are exposed as REST under /api/v1 (OpenAPI routes). */
const rpc = new RPCHandler(router, { interceptors: [logUnexpected] });
const rest = new OpenAPIHandler(router, {
  interceptors: [logUnexpected],
  // Query strings arrive as strings; coerce them to the contract's number/boolean/date types.
  plugins: [new experimental_ZodSmartCoercionPlugin()],
});

export const app = new Hono();

// API responses are JSON/SSE only, so the strictest CSP applies; HSTS only matters behind TLS.
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    strictTransportSecurity: env.isProd ? "max-age=31536000; includeSubDomains" : false,
    crossOriginResourcePolicy: "same-site",
    xFrameOptions: "DENY",
    referrerPolicy: "no-referrer",
  }),
);

// Uploads go straight to S3, so request bodies stay small (webhooks included).
const MAX_BODY = 5 * 1024 * 1024;
app.use(
  "*",
  bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "payload too large" }, 413) }),
);

app.use(
  "*",
  cors({
    origin: [env.WEB_ORIGIN, env.FLOOR_ORIGIN],
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "X-Station-Token", "Last-Event-ID"],
    exposeHeaders: ["Content-Length"],
  }),
);

// Public and unauthenticated: dependency status only. Which providers run on mocks is logged at
// startup (server.ts) and never exposed here.
app.get("/health", async (c) => {
  const checks = await Promise.all([
    db
      .execute(sql`select 1`)
      .then(() => true)
      .catch(() => false),
    redis
      .ping()
      .then((r) => r === "PONG")
      .catch(() => false),
    imaging.isUp(),
    s3Healthy(),
  ]);
  const [dbOk, redisOk, imagingOk, s3Ok] = checks;
  const ok = dbOk && redisOk;
  return c.json(
    {
      ok,
      db: dbOk,
      redis: redisOk,
      imaging: imagingOk,
      s3: s3Ok,
      version: process.env.npm_package_version ?? "dev",
    },
    ok ? 200 : 503,
  );
});

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use("/rpc/*", async (c, next) => {
  const context = await buildContext(c.req.raw);
  const { matched, response } = await rpc.handle(c.req.raw, { prefix: "/rpc", context });
  if (matched) return c.newResponse(response.body, response);
  await next();
});

app.use("/api/v1/*", async (c, next) => {
  const context = await buildContext(c.req.raw);
  const { matched, response } = await rest.handle(c.req.raw, { prefix: "/api/v1", context });
  if (matched) return c.newResponse(response.body, response);
  await next();
});

// The mock Shopify provider signs with a constant secret; never accept those webhooks in production.
const noMockWebhooksInProd = async (c: Context, next: Next) => {
  if (env.isProd && env.mocks.shopify) return c.json({ error: "not found" }, 404);
  await next();
};
app.use("/webhooks/shopify", noMockWebhooksInProd);
app.use("/webhooks/shopify/*", noMockWebhooksInProd);
app.route("/webhooks", webhooks);
app.route(REALTIME_SSE_PATH, events);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  log.error("request failed", { path: c.req.path, ...errorData(err) });
  return c.json({ error: "internal error" }, 500);
});
