import { REALTIME_SSE_PATH } from "@invai/contracts";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
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
import { internal } from "./internal";
import { links } from "./links";
import { router } from "./router";
import { webhooks } from "./webhooks";
import { carrierWebhooks } from "./webhooks-carriers";
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

/** Apps talk RPC at /rpc; the same procedures are exposed as REST under /api/v1 (OpenAPI routes).
 * `ResponseHeadersPlugin` injects `context.resHeaders`, so a middleware (the rate limiter's
 * `Retry-After`, orpc.ts) can set a response header even on the request that it throws for. */
const rpc = new RPCHandler(router, {
  interceptors: [logUnexpected],
  plugins: [new ResponseHeadersPlugin()],
});
const rest = new OpenAPIHandler(router, {
  interceptors: [logUnexpected],
  // Query strings arrive as strings; coerce them to the contract's number/boolean/date types.
  plugins: [new experimental_ZodSmartCoercionPlugin(), new ResponseHeadersPlugin()],
});

export const app = new Hono();

// API responses are JSON/SSE only, so the strictest CSP applies; HSTS only matters behind TLS.
// Permissions-Policy denies every browser feature outright: nothing here is rendered as HTML,
// so there is no legitimate caller for camera/mic/geolocation/payment on this origin (T-12-5).
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    strictTransportSecurity: env.isProd ? "max-age=31536000; includeSubDomains" : false,
    crossOriginResourcePolicy: "same-site",
    xFrameOptions: "DENY",
    referrerPolicy: "no-referrer",
    permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [] },
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
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Station-Token",
      "X-Contract-Version",
      "Last-Event-ID",
    ],
    exposeHeaders: ["Content-Length"],
  }),
);

// Public and unauthenticated: dependency status only. Which providers run on mocks is logged at
// startup (server.ts) and never exposed here.
const checkDb = () =>
  db
    .execute(sql`select 1`)
    .then(() => true)
    .catch(() => false);
const checkRedis = () =>
  redis
    .ping()
    .then((r) => r === "PONG")
    .catch(() => false);

app.get("/health", async (c) => {
  const [dbOk, redisOk, imagingOk, s3Ok] = await Promise.all([
    checkDb(),
    checkRedis(),
    imaging.isUp(),
    s3Healthy(),
  ]);
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

// Liveness (T-12-2, B-16): the process is up and can answer HTTP, full stop. No DB/Redis/imaging/S3
// calls, so a dependency outage never fails this -- an orchestrator must not restart a healthy
// process just because its database is down (that would make an outage worse, not better).
app.get("/livez", (c) => c.json({ ok: true }));

// Readiness: same DB/Redis checks as /health, without imaging/S3 (those degrade a feature, not
// whether this instance should receive traffic). 503 takes an instance out of a load balancer's
// rotation without restarting it.
app.get("/readyz", async (c) => {
  const [dbOk, redisOk] = await Promise.all([checkDb(), checkRedis()]);
  const ok = dbOk && redisOk;
  return c.json({ ok, db: dbOk, redis: redisOk }, ok ? 200 : 503);
});

// Internal-only DLQ/redrive routes (X-Internal-Token; 404 otherwise). See internal.ts.
app.route("/internal", internal);

// Public signed email links (one-click unsubscribe, clicks): no session, token-bound. See links.ts.
app.route("/l", links);

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
// Same for EasyPost: without EASYPOST_WEBHOOK_SECRET the route checks the mock dev secret.
const noMockEasypostWebhooksInProd = async (c: Context, next: Next) => {
  if (env.isProd && !env.EASYPOST_WEBHOOK_SECRET) return c.json({ error: "not found" }, 404);
  await next();
};
app.use("/webhooks/easypost", noMockEasypostWebhooksInProd);
app.use("/webhooks/easypost/*", noMockEasypostWebhooksInProd);
// Carrier webhooks are their own top-level route, registered before `/webhooks/:channel`.
app.route("/webhooks/easypost", carrierWebhooks);
app.route("/webhooks", webhooks);
app.route(REALTIME_SSE_PATH, events);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  log.error("request failed", { path: c.req.path, ...errorData(err) });
  return c.json({ error: "internal error" }, 500);
});
