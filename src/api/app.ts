import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "../auth";
import { env } from "../env";
import { events } from "./events";
import { router } from "./router";
import { webhooks } from "./webhooks";

const rpc = new RPCHandler(router);

export const app = new Hono();

app.use("*", cors({ origin: env.WEB_ORIGIN, credentials: true }));

app.get("/health", (c) => c.json({ ok: true }));

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use("/rpc/*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const { matched, response } = await rpc.handle(c.req.raw, {
    prefix: "/rpc",
    context: {
      userId: session?.user.id ?? null,
      companyId: session?.session.activeOrganizationId ?? null,
    },
  });
  if (matched) return c.newResponse(response.body, response);
  await next();
});

app.route("/webhooks", webhooks);
app.route("/events", events);
