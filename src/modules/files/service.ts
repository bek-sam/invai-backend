import type { Permission, PresignedUpload, SignedDownload } from "@invai/contracts";
import { eq, inArray, or } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { type Tx, withVendor } from "../../db/client";
import { files, gangSheets } from "../../db/schema";
import { notFound, ORPCError } from "../../lib/errors";
import { headObject, isSafeKey, objectKey, presignGet, presignPut } from "../../lib/s3";

/*
 * Direct-to-S3 uploads and short-lived download links. Keys are `{companyId}/{kind}/...`, so
 * ownership is checked by prefix; vendors may additionally read sheet files shared with them
 * (checked through the vendor RLS policy on gang_sheets).
 */

type Kind = PresignInput["kind"];

const LIMITS: Record<Kind, { maxBytes: number; types: RegExp }> = {
  design: {
    maxBytes: 200 * 1024 * 1024,
    types: /^(image\/png|image\/svg\+xml|application\/pdf|image\/tiff)$/,
  },
  artwork: { maxBytes: 50 * 1024 * 1024, types: /^image\/png$/ },
  template_background: { maxBytes: 50 * 1024 * 1024, types: /^image\/(png|svg\+xml)$/ },
  csv: {
    maxBytes: 25 * 1024 * 1024,
    types: /^(text\/csv|text\/plain|application\/vnd\.ms-excel|application\/csv)$/,
  },
  photo: { maxBytes: 25 * 1024 * 1024, types: /^image\/(png|jpeg|webp|heic)$/ },
  mockup: { maxBytes: 25 * 1024 * 1024, types: /^image\/(png|jpeg|webp)$/ },
  // No html/svg/js: the bucket serves objects inline, so those would be script on its origin.
  other: {
    maxBytes: 25 * 1024 * 1024,
    types: /^(application\/(pdf|zip|octet-stream)|image\/(png|jpeg|webp)|text\/(csv|plain))$/,
  },
};

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "image/tiff": "tif",
  "text/csv": "csv",
  "text/plain": "csv",
  "application/csv": "csv",
  "application/vnd.ms-excel": "csv",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
};

export type PresignInput = {
  kind: "design" | "artwork" | "template_background" | "csv" | "photo" | "mockup" | "other";
  filename: string;
  contentType: string;
  sizeBytes: number;
};

const UPLOAD_TTL = 15 * 60;

export async function presignUpload(
  tx: Tx,
  ctx: TenantContext,
  input: PresignInput,
): Promise<PresignedUpload> {
  const limit = LIMITS[input.kind];
  if (input.sizeBytes > limit.maxBytes) {
    throw new ORPCError("FILE_TOO_LARGE", {
      status: 413,
      message: "File exceeds the limit for this kind",
      data: { maxBytes: limit.maxBytes },
    });
  }
  if (!limit.types.test(input.contentType)) {
    throw new ORPCError("UNSUPPORTED_TYPE", {
      status: 415,
      message: "Content type not allowed for this kind",
    });
  }
  // The extension is the only user-influenced part of a key; keep it to a short alphanumeric.
  const guessed = input.filename.split(".").pop()?.toLowerCase() ?? "";
  const ext = EXT[input.contentType] ?? (/^[a-z0-9]{1,8}$/.test(guessed) ? guessed : "bin");
  const key = objectKey(ctx.companyId, input.kind, ext);
  await tx.insert(files).values({
    companyId: ctx.companyId,
    key,
    kind: input.kind,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    uploadedBy: ctx.userId,
    status: "pending",
  });
  const uploadUrl = await presignPut(key, input.contentType, UPLOAD_TTL, input.sizeBytes);
  return {
    fileKey: key,
    uploadUrl,
    method: "PUT",
    // The browser sets content-length from the body; both are part of the signature.
    headers: { "content-type": input.contentType },
    expiresAt: new Date(Date.now() + UPLOAD_TTL * 1000).toISOString(),
  };
}

const DOWNLOAD_TTL = 15 * 60;

export async function downloadUrl(
  _tx: Tx,
  ctx: TenantContext,
  input: { fileKey: string; disposition: "inline" | "attachment" },
): Promise<SignedDownload> {
  if (!isSafeKey(input.fileKey)) throw notFound("file");
  const owned = input.fileKey.startsWith(`${ctx.companyId}/`);
  if (
    !owned &&
    !(ctx.orgType === "vendor" && (await vendorCanRead(ctx.companyId, input.fileKey)))
  ) {
    throw notFound("file");
  }
  if (owned && !canReadKind(ctx, input.fileKey.split("/")[1] ?? "")) throw notFound("file");
  const head = await headObject(input.fileKey);
  if (!head.exists) throw notFound("file");
  const name = input.disposition === "attachment" ? input.fileKey.split("/").pop() : undefined;
  return {
    fileKey: input.fileKey,
    url: await presignGet(input.fileKey, DOWNLOAD_TTL, name),
    expiresAt: new Date(Date.now() + DOWNLOAD_TTL * 1000).toISOString(),
    contentType: head.contentType,
    sizeBytes: head.size,
  };
}

/*
 * Kinds that carry buyer personal data need more than `files.read` (which pressers and
 * designers have): raw channel payloads never leave through this endpoint, uploaded CSVs
 * (order exports) only to people who import them, labels only to shipping roles.
 */
const KIND_PERMISSIONS: Record<string, Permission[] | null> = {
  raw: null,
  csv: ["channels.import", "catalog.manage", "finance.manage"],
  label: ["shipping.read"],
};

function canReadKind(ctx: TenantContext, kind: string): boolean {
  if (!(kind in KIND_PERMISSIONS)) return true;
  const needed = KIND_PERMISSIONS[kind];
  return !!needed?.some((p) => ctx.permissions.has(p));
}

/** A vendor may read a key only when it belongs to a sheet the vendor RLS policy exposes. */
async function vendorCanRead(vendorCompanyId: string, key: string): Promise<boolean> {
  return withVendor(vendorCompanyId, async (tx) => {
    const [row] = await tx
      .select({ id: gangSheets.id })
      .from(gangSheets)
      .where(
        or(eq(gangSheets.pngKey, key), eq(gangSheets.pdfKey, key), eq(gangSheets.previewKey, key)),
      )
      .limit(1);
    return !!row;
  });
}

/** Mark an uploaded key as ready (called by services once they consume it). */
export async function markFileReady(tx: Tx, key: string) {
  await tx.update(files).set({ status: "ready" }).where(eq(files.key, key));
}

/** Drop `files` rows whose objects were deleted (retention sweep). */
export async function forgetFiles(tx: Tx, keys: string[]) {
  if (keys.length) await tx.delete(files).where(inArray(files.key, keys));
}
