import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";
import { logger } from "./log";

const log = logger("s3");

/**
 * One private bucket (S3_BUCKET). MinIO locally with path-style URLs. The imaging service reads
 * and writes the same bucket by key, so the backend only ever passes keys around and presigns
 * URLs for browsers.
 */
export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials:
    env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
      : undefined,
});

/**
 * Presigning client (on S3_PUBLIC_ENDPOINT when the browser reaches MinIO on a different host).
 * Checksums only when required: otherwise the SDK signs a CRC32 of an empty body into every
 * presigned PUT, which real S3 rejects for the actual upload.
 */
const presigner = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  requestChecksumCalculation: "WHEN_REQUIRED",
  credentials:
    env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
      : undefined,
});

export const bucket = env.S3_BUCKET;

/** Key layout: `{companyId}/{kind}/{yyyy}/{mm}/{uuid}.{ext}`; keys never contain user input. */
export function objectKey(companyId: string, kind: string, ext: string, id = crypto.randomUUID()) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${companyId}/${kind}/${yyyy}/${mm}/${id}.${ext.replace(/^\./, "")}`;
}

/** Object keys we generate or accept: no empty segments, no `.`/`..`, no leading slash. */
const SAFE_KEY = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
export function isSafeKey(key: string): boolean {
  return key.length <= 512 && SAFE_KEY.test(key) && !key.split("/").some((p) => p === "..");
}

/** Keys taken from API input must be well formed and inside the caller's company prefix. */
export function isCompanyKey(companyId: string, key: string): boolean {
  return isSafeKey(key) && key.startsWith(`${companyId}/`);
}

/**
 * Presigned PUT that binds the content type and exact byte size into the signature, so the
 * browser cannot upload a different type or a larger file than the one we validated.
 */
export async function presignPut(
  key: string,
  contentType: string,
  expiresIn = 900,
  sizeBytes?: number,
) {
  return getSignedUrl(
    presigner,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
    }),
    {
      expiresIn,
      signableHeaders: new Set(
        sizeBytes === undefined ? ["content-type"] : ["content-type", "content-length"],
      ),
    },
  );
}

/** `attachment` header value with an ASCII-safe fallback name and an RFC 5987 UTF-8 name. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_").slice(0, 150) || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename.slice(0, 150))}`;
}

export async function presignGet(key: string, expiresIn = 3600, downloadName?: string) {
  return getSignedUrl(
    presigner,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: downloadName ? contentDisposition(downloadName) : undefined,
    }),
    { expiresIn },
  );
}

export async function putObject(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string,
) {
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) throw new Error(`empty object ${key}`);
  return Buffer.from(bytes);
}

export async function headObject(key: string) {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      exists: true as const,
      size: res.ContentLength ?? null,
      contentType: res.ContentType ?? null,
    };
  } catch (err) {
    if ((err as { name?: string }).name === "NotFound") return { exists: false as const };
    throw err;
  }
}

export async function deleteObject(key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Local dev: create the bucket on first run. No-op when it exists or in production. */
export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    if (env.isProd) throw new Error(`bucket ${bucket} missing`);
    log.info("creating bucket", { bucket });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function s3Healthy(): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}
