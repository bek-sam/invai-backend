import { basename } from "node:path";
import type { PhotoPush, PushTarget, PushToShopifyInput } from "@invai/contracts";
import { and, desc, eq, ilike, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx, withTenant } from "../../db/client";
import {
  channelConnections,
  listings,
  photoCompositions,
  photoImages,
  photoPushes,
  photoSets,
} from "../../db/schema";
import { getChannelAdapter } from "../../integrations/channels";
import { ProductImagePushError } from "../../integrations/channels/types";
import { audit } from "../../lib/audit";
import { sha256Hex } from "../../lib/crypto";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { logger } from "../../lib/log";
import { isCompanyKey, presignGet } from "../../lib/s3";
import { getDesign } from "../catalog/service";
import { freshChannelConn, getConnectionRow } from "../channels/service";
import {
  loadSetRow,
  type PushJobInput,
  publishSet,
  publishSetAfterCommit,
  pushEnqueuer,
  toPush,
} from "./service";

/*
 * Shopify image push (phase B, T-27-3, ADR 0023 §4, §7). The request checks everything under the
 * tenant and stores a `photo_pushes` row (idempotent on the client key); a job sends the approved
 * images to the product through the channel adapter's `pushProductImages`, outside any
 * transaction. Shopify names each file after the URL's last segment, `<imageId>.jpg`, and the
 * adapter skips files the product already has, so a retried job adds nothing twice.
 */

const log = logger("photos.push");

/**
 * Presigned GET lifetime for the image URLs Shopify downloads asynchronously after the mutation.
 * Shopify fetches within minutes; 6 hours covers queue delays and its own retries, and stays
 * within the lifetime of temporary (role) S3 credentials.
 */
export const PUSH_URL_TTL_S = 6 * 60 * 60;

type PushRow = typeof photoPushes.$inferSelect;

const productGid = (channelListingId: string) => `gid://shopify/Product/${channelListingId}`;

function safeUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/* ---- Push targets ------------------------------------------------------------------------- */

function encodeTargetCursor(m: number, createdAt: Date, id: string) {
  return Buffer.from(`${m}|${createdAt.toISOString()}|${id}`).toString("base64url");
}

function decodeTargetCursor(cursor: string) {
  const [m, ts, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const createdAt = new Date(ts ?? "");
  if ((m !== "0" && m !== "1") || !id || Number.isNaN(createdAt.getTime()))
    throw badRequest("Invalid cursor");
  return { m: Number(m), createdAt, id };
}

/**
 * The shop's Shopify listings a push can target, this design's first. A tolerated read of the
 * channels module's `listings` and `channel_connections` tables (wave 27 plan review item 7: the
 * contract's `productRef` is a backend listing); read only, under the tenant, never written here.
 */
export async function pushTargets(
  tx: Tx,
  ctx: TenantContext,
  input: {
    designId: string;
    connectionId?: string;
    search?: string;
    cursor?: string;
    limit: number;
  },
): Promise<{ items: PushTarget[]; nextCursor: string | null }> {
  const design = await getDesign(tx, ctx, input.designId);
  const m = sql<number>`(case when ${listings.designId} = ${design.id} then 1 else 0 end)`;
  const filters: (SQL | undefined)[] = [
    eq(listings.channel, "shopify"),
    eq(channelConnections.channel, "shopify"),
    ne(channelConnections.status, "disconnected"),
    input.connectionId ? eq(listings.connectionId, input.connectionId) : undefined,
    input.search?.trim() ? ilike(listings.title, `%${input.search.trim()}%`) : undefined,
  ];
  if (input.cursor) {
    const c = decodeTargetCursor(input.cursor);
    filters.push(
      or(
        sql`${m} < ${c.m}`,
        and(sql`${m} = ${c.m}`, sql`${listings.createdAt} < ${c.createdAt}`),
        and(
          sql`${m} = ${c.m}`,
          sql`${listings.createdAt} = ${c.createdAt}`,
          sql`${listings.id} < ${c.id}`,
        ),
      ),
    );
  }
  const rows = await tx
    .select({ l: listings, connectionName: channelConnections.name, m })
    .from(listings)
    .innerJoin(channelConnections, eq(channelConnections.id, listings.connectionId))
    .where(and(...filters))
    .orderBy(desc(m), desc(listings.createdAt), desc(listings.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ l, connectionName }) => ({
      listingId: l.id,
      connectionId: l.connectionId,
      connectionName,
      channel: "shopify" as const,
      channelListingId: l.channelListingId,
      title: l.title,
      url: safeUrl(l.url),
      designId: l.designId,
      matchesDesign: l.designId === design.id,
    })),
    nextCursor:
      rows.length > input.limit && last
        ? encodeTargetCursor(Number(last.m), last.l.createdAt, last.l.id)
        : null,
  };
}

/* ---- Push request ------------------------------------------------------------------------- */

const pushBadRequest = (
  reason: "not_shopify_connection" | "listing_not_on_connection" | "not_approved",
  count: number | null,
  message: string,
) => badRequest(message, { reason, count });

function requestHash(input: PushToShopifyInput): string {
  return sha256Hex(
    JSON.stringify({
      setId: input.setId,
      connectionId: input.connectionId,
      listingId: input.productRef.listingId,
      imageIds: [...new Set(input.imageIds)].sort(),
    }),
  );
}

/** Shopify names the file after the URL's last segment; ours is always `<imageId>.jpg`. */
const pushable = (companyId: string, i: { id: string; key: string | null }) =>
  !!i.key && isCompanyKey(companyId, i.key) && basename(i.key) === `${i.id}.jpg`;

export async function pushToShopify(
  tx: Tx,
  ctx: TenantContext,
  input: PushToShopifyInput,
): Promise<PhotoPush> {
  const hash = requestHash(input);
  const same = async (row: PushRow) => {
    if (row.requestHash !== hash)
      throw conflict("This request key was already used for a different push");
    return toPush(row);
  };
  const [existing] = await tx
    .select()
    .from(photoPushes)
    .where(eq(photoPushes.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing) return same(existing);

  const s = await loadSetRow(tx, input.setId);
  const conn = await getConnectionRow(tx, input.connectionId);
  if (conn.channel !== "shopify" || conn.status === "disconnected")
    throw pushBadRequest("not_shopify_connection", null, "Choose a connected Shopify store");
  const [listing] = await tx
    .select()
    .from(listings)
    .where(eq(listings.id, input.productRef.listingId))
    .limit(1);
  if (!listing) throw notFound("listing", input.productRef.listingId);
  if (
    listing.connectionId !== conn.id ||
    listing.channel !== "shopify" ||
    !/^\d+$/.test(listing.channelListingId)
  )
    throw pushBadRequest(
      "listing_not_on_connection",
      null,
      "This product is not on the chosen Shopify store",
    );

  const ids = [...new Set(input.imageIds)];
  const rows = await tx
    .select()
    .from(photoImages)
    .where(and(eq(photoImages.setId, s.id), inArray(photoImages.id, ids)))
    .orderBy(photoImages.slot);
  if (rows.length < ids.length)
    throw badRequest("Some images are not part of this set", {
      reason: "image_not_in_set",
      count: ids.length - rows.length,
    });
  const skipped: PhotoPush["skipped"] = [];
  const ok: string[] = [];
  for (const r of rows) {
    if (r.status !== "approved" || !pushable(ctx.companyId, r))
      skipped.push({ imageId: r.id, reason: "not_approved" });
    else if (r.channel !== "shopify") skipped.push({ imageId: r.id, reason: "channel_mismatch" });
    else ok.push(r.id);
  }
  if (ok.length === 0) {
    const notApproved = skipped.filter((e) => e.reason === "not_approved").length;
    if (notApproved > 0)
      throw pushBadRequest("not_approved", notApproved, "Approve the images before pushing them");
    throw badRequest("These images were made for another channel than Shopify", {
      reason: "channel_mismatch",
      count: skipped.length,
    });
  }

  const [row] = await tx
    .insert(photoPushes)
    .values({
      companyId: ctx.companyId,
      setId: s.id,
      connectionId: conn.id,
      listingId: listing.id,
      productGid: productGid(listing.channelListingId),
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      imageIds: ok,
      skipped,
      requestedBy: ctx.userId,
    })
    .onConflictDoNothing({ target: [photoPushes.companyId, photoPushes.idempotencyKey] })
    .returning();
  if (!row) {
    const [raced] = await tx
      .select()
      .from(photoPushes)
      .where(eq(photoPushes.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!raced) throw conflict("This request is already being processed");
    return same(raced);
  }
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "photos.pushed_to_shopify",
    entityType: "photo_set",
    entityId: s.id,
    summary: `Sent ${ok.length} listing photos to a Shopify product`,
    data: {
      pushId: row.id,
      connectionId: conn.id,
      listingId: listing.id,
      images: ok.length,
      skipped: skipped.length,
    },
  });
  const job = { companyId: ctx.companyId, pushId: row.id };
  afterCommit(tx, () =>
    pushEnqueuer()(job).catch(async (err) => {
      log.error("photo push enqueue failed", { ...job, error: (err as Error).message });
      await finishPush(job, {
        status: "failed",
        error: "The push could not be started. Try again.",
      });
    }),
  );
  publishSetAfterCommit(tx, ctx.companyId, s.id);
  return toPush(row);
}

/* ---- Push job ----------------------------------------------------------------------------- */

const FINAL = ["pushed", "partial", "failed"] as const;

async function finishPush(
  job: PushJobInput,
  result: Partial<Pick<PushRow, "pushed" | "skipped">> & {
    status: "pushed" | "partial" | "failed";
    error?: string | null;
  },
) {
  const setId = await withTenant(job.companyId, async (tx) => {
    const [row] = await tx
      .update(photoPushes)
      .set({ ...result, error: result.error ?? null, completedAt: new Date() })
      .where(
        and(eq(photoPushes.id, job.pushId), inArray(photoPushes.status, ["queued", "pushing"])),
      )
      .returning({ setId: photoPushes.setId });
    return row?.setId ?? null;
  });
  if (setId) void publishSet(job.companyId, setId);
}

export async function runPush(
  job: PushJobInput,
  finalAttempt: boolean,
): Promise<{ status: PhotoPush["status"] | "skipped"; pushed?: number; skipped?: number }> {
  const plan = await withTenant(job.companyId, async (tx) => {
    const [p] = await tx.select().from(photoPushes).where(eq(photoPushes.id, job.pushId)).limit(1);
    if (!p || (FINAL as readonly string[]).includes(p.status)) return null;
    const [s] = await tx.select().from(photoSets).where(eq(photoSets.id, p.setId)).limit(1);
    const conn = await getConnectionRow(tx, p.connectionId);
    const imgs = p.imageIds.length
      ? await tx
          .select({ i: photoImages, c: photoCompositions })
          .from(photoImages)
          .innerJoin(photoCompositions, eq(photoCompositions.id, photoImages.compositionId))
          .where(and(eq(photoImages.setId, p.setId), inArray(photoImages.id, p.imageIds)))
          .orderBy(photoImages.slot)
      : [];
    await tx.update(photoPushes).set({ status: "pushing" }).where(eq(photoPushes.id, p.id));
    return { p, designName: s?.designName ?? "", conn, imgs };
  });
  if (!plan) return { status: "skipped" };
  const { p, conn } = plan;
  // Re-checked at run time: an image unapproved since the request is left out.
  const skipped = [...p.skipped];
  const send = plan.imgs.filter(({ i }) => {
    const ok = i.status === "approved" && pushable(job.companyId, i);
    if (!ok) skipped.push({ imageId: i.id, reason: "not_approved" });
    return ok;
  });
  if (conn.channel !== "shopify" || conn.status === "disconnected") {
    await finishPush(job, {
      status: "failed",
      skipped,
      error: "The Shopify store is disconnected.",
    });
    return { status: "failed" };
  }
  if (send.length === 0) {
    await finishPush(job, { status: "failed", skipped, error: "No approved photos to send." });
    return { status: "failed" };
  }
  const adapter = await getChannelAdapter("shopify", conn.provider, { companyId: job.companyId });
  if (!adapter.pushProductImages) {
    await finishPush(job, { status: "failed", skipped, error: "This store can't receive photos." });
    return { status: "failed" };
  }
  const images = await Promise.all(
    send.map(async ({ i, c }) => ({
      url: await presignGet(i.key as string, PUSH_URL_TTL_S),
      alt: (i.altText ?? `${plan.designName} ${c.garment} in ${c.colorName}`).slice(0, 250),
      filename: `${i.id}.jpg`,
    })),
  );
  const imageByFile = new Map(send.map(({ i }) => [`${i.id}.jpg`.toLowerCase(), i.id]));
  let result: Awaited<ReturnType<NonNullable<typeof adapter.pushProductImages>>>;
  try {
    const chConn = await freshChannelConn(conn);
    result = await adapter.pushProductImages(chConn, {
      productGid: p.productGid,
      images,
      // Stable per (set, product, image set); each image is also deduped by its file name.
      idempotencyKey: `photo-push:${p.setId}:${p.listingId}:${sha256Hex(
        send
          .map(({ i }) => i.id)
          .sort()
          .join(","),
      )}`,
    });
  } catch (err) {
    if (err instanceof ProductImagePushError) {
      log.warn("photo push refused", { ...job, code: err.code, outcome: err.outcome });
      const status = err.outcome === "partial" ? "partial" : "failed";
      await finishPush(job, { status, skipped, error: err.message });
      return { status };
    }
    log.warn("photo push failed", { ...job, finalAttempt, error: (err as Error).message });
    if (!finalAttempt) throw err;
    await finishPush(job, {
      status: "failed",
      skipped,
      error: "Shopify did not answer. Try the push again.",
    });
    return { status: "failed" };
  }
  const idOf = (filename: string) => imageByFile.get(filename.toLowerCase());
  const pushed = result.pushed.flatMap((r) => {
    const imageId = idOf(r.filename);
    return imageId ? [{ imageId, mediaId: r.mediaId }] : [];
  });
  for (const r of result.skipped) {
    const imageId = idOf(r.filename);
    if (imageId) skipped.push({ imageId, reason: "already_pushed" });
  }
  await finishPush(job, { status: "pushed", pushed, skipped });
  log.info("photo push done", { ...job, pushed: pushed.length, skipped: skipped.length });
  return { status: "pushed", pushed: pushed.length, skipped: skipped.length };
}

/** Final failure of a push job (BullMQ gave up): the push ends `failed` with a readable reason. */
export async function failPush(job: PushJobInput, error: string) {
  await finishPush(job, { status: "failed", error });
}
