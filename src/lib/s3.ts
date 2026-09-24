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

/** Presigning client: when the browser reaches MinIO on a different host than the API does. */
const presigner = env.S3_PUBLIC_ENDPOINT
  ? new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_PUBLIC_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
          : undefined,
    })
  : s3;

export const bucket = env.S3_BUCKET;

/** Key layout: `{companyId}/{kind}/{yyyy}/{mm}/{uuid}.{ext}`; keys never contain user input. */
export function objectKey(companyId: string, kind: string, ext: string, id = crypto.randomUUID()) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${companyId}/${kind}/${yyyy}/${mm}/${id}.${ext.replace(/^\./, "")}`;
}

export async function presignPut(key: string, contentType: string, expiresIn = 900) {
  return getSignedUrl(
    presigner,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    {
      expiresIn,
    },
  );
}

export async function presignGet(key: string, expiresIn = 3600, downloadName?: string) {
  return getSignedUrl(
    presigner,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: downloadName
        ? `attachment; filename="${downloadName}"`
        : undefined,
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
