import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { customType } from "drizzle-orm/pg-core";

/**
 * Field encryption for buyer PII and channel credentials: AES-256-GCM with a key ring.
 * Ciphertext format: `<keyId>:<base64(iv(12) | tag(16) | data)>`. The first key in
 * FIELD_ENCRYPTION_KEY encrypts; every key decrypts, so rotation is "prepend a key, re-encrypt
 * lazily". KMS envelope keys can replace the ring later without changing the column format.
 */

type KeyRing = { primary: { id: string; key: Buffer }; all: Map<string, Buffer> };
let ring: KeyRing | null = null;

function loadRing(): KeyRing {
  if (ring) return ring;
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) throw new Error("FIELD_ENCRYPTION_KEY is not set");
  const all = new Map<string, Buffer>();
  let primary: KeyRing["primary"] | null = null;
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) throw new Error("FIELD_ENCRYPTION_KEY entries must look like keyId:base64");
    const id = part.slice(0, idx).trim();
    const key = Buffer.from(part.slice(idx + 1).trim(), "base64");
    if (key.length !== 32) throw new Error(`FIELD_ENCRYPTION_KEY ${id} must decode to 32 bytes`);
    all.set(id, key);
    primary ??= { id, key };
  }
  if (!primary) throw new Error("FIELD_ENCRYPTION_KEY is empty");
  ring = { primary, all };
  return ring;
}

/** Test hook: forget the cached key ring (used after changing the env var). */
export function resetKeyRing() {
  ring = null;
}

export function encryptField(plain: string): string {
  const { primary } = loadRing();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", primary.key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${primary.id}:${Buffer.concat([iv, tag, data]).toString("base64")}`;
}

export function decryptField(stored: string): string {
  const idx = stored.indexOf(":");
  if (idx <= 0) throw new Error("Malformed encrypted field");
  const keyId = stored.slice(0, idx);
  const key = loadRing().all.get(keyId);
  if (!key) throw new Error(`Unknown encryption key id ${keyId}`);
  const buf = Buffer.from(stored.slice(idx + 1), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** True when the stored value was encrypted with a key other than the current primary. */
export function needsReencrypt(stored: string): boolean {
  return !stored.startsWith(`${loadRing().primary.id}:`);
}

/**
 * Drizzle column type: a `text` column that is encrypted on write and decrypted on read.
 * Use it like `name: encryptedText()`. Filtering on it in SQL is impossible by design.
 */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => encryptField(value),
  fromDriver: (value) => decryptField(value),
});

/** Encrypt a JSON value (e.g. OAuth credentials) into one field. */
export function encryptJson(value: unknown): string {
  return encryptField(JSON.stringify(value));
}
export function decryptJson<T = unknown>(stored: string): T {
  return JSON.parse(decryptField(stored)) as T;
}

/** Opaque random token, URL-safe. 32 bytes → 43 chars. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 hex, used to store station tokens (long random secrets need no salt). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Compact signed token: base64url(json).base64url(hmac). Used for floor sessions. */
export function signPayload(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyPayload<T = Record<string, unknown>>(
  secret: string,
  token: string,
): T | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
