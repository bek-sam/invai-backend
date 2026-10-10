import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Field-encryption key providers (T-32-2, ADR 0034). A provider turns configuration into the key
 * ring once at start; `crypto.ts` then encrypts and decrypts synchronously with that ring.
 *
 * - `static` (default): the `FIELD_ENCRYPTION_KEY` ring, read lazily, exactly as before.
 * - `local`: envelope encryption shaped like KMS. Data keys are stored wrapped
 *   (`FIELD_ENCRYPTION_DATA_KEYS=keyId:base64(iv|tag|wrapped)`) and unwrapped with a local master
 *   key (AES-256-GCM, AAD = keyId, which maps to a KMS EncryptionContext). The first data key
 *   encrypts; the static ring stays in the ring decrypt-only, so older values stay readable.
 * - `kms`: refused until the AWS KMS adapter exists (backlog B-327). That adapter is one new
 *   provider with an injected client, returning the same `KeyRing`.
 *
 * No message here ever contains key material, wrapped or plain: errors name key ids only.
 */

export const FIELD_ENCRYPTION_PROVIDERS = ["static", "local", "kms"] as const;
export type FieldEncryptionProviderName = (typeof FIELD_ENCRYPTION_PROVIDERS)[number];

export type DataKey = { id: string; key: Buffer };
export type KeyRing = { primary: DataKey; all: Map<string, Buffer> };

export interface FieldKeyProvider {
  readonly name: FieldEncryptionProviderName;
  /** Builds the full ring: `primary` encrypts, every key in `all` decrypts. */
  loadDataKeys(): Promise<KeyRing>;
}

/** Same shape for every ring and wrapped key: short, printable, no `:` or `,`. */
const KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export const KMS_NOT_BUILT_MESSAGE =
  "FIELD_ENCRYPTION_PROVIDER=kms: the AWS KMS adapter is not built yet (backlog B-327). " +
  "Set FIELD_ENCRYPTION_PROVIDER=static to use the FIELD_ENCRYPTION_KEY ring until it lands.";

/** Reads the provider name from raw env text. Blank means `static`; anything unknown throws. */
export function providerName(raw: string | undefined): FieldEncryptionProviderName {
  const v = raw?.trim() || "static";
  if ((FIELD_ENCRYPTION_PROVIDERS as readonly string[]).includes(v)) {
    return v as FieldEncryptionProviderName;
  }
  throw new Error(
    `FIELD_ENCRYPTION_PROVIDER must be one of ${FIELD_ENCRYPTION_PROVIDERS.join(", ")}`,
  );
}

/** `local` is a development provider: production refuses it unless ALLOW_MOCKS=true. */
export function assertProviderAllowed(
  name: FieldEncryptionProviderName,
  opts: { isProd: boolean; allowMocks: boolean },
): void {
  if (name === "local" && opts.isProd && !opts.allowMocks) {
    throw new Error(
      "Refusing to start in production: FIELD_ENCRYPTION_PROVIDER=local keeps the master key in " +
        "an env var. Use static (or kms once built), or set ALLOW_MOCKS=true for a demo or " +
        "staging stage only.",
    );
  }
}

function decode32(b64: string, what: string): Buffer {
  const key = Buffer.from(b64.trim(), "base64");
  if (key.length !== 32) throw new Error(`${what} must decode to 32 bytes`);
  return key;
}

/** Splits `id:base64[,id:base64]` into entries, validating ids. Never echoes a value. */
function parseEntries(raw: string, varName: string): { id: string; value: string }[] {
  const out: { id: string; value: string }[] = [];
  const seen = new Set<string>();
  raw.split(",").forEach((part, i) => {
    const idx = part.indexOf(":");
    if (idx <= 0) throw new Error(`${varName} entries must look like keyId:base64`);
    const id = part.slice(0, idx).trim();
    if (!KEY_ID.test(id)) {
      throw new Error(`${varName} entry ${i + 1} has an invalid key id (letters, digits, _ . -)`);
    }
    if (seen.has(id)) throw new Error(`${varName} lists key id ${id} twice`);
    seen.add(id);
    out.push({ id, value: part.slice(idx + 1) });
  });
  if (!out.length) throw new Error(`${varName} is empty`);
  return out;
}

/** The static `FIELD_ENCRYPTION_KEY` ring: the first key encrypts, every key decrypts. */
export function parseStaticRing(raw: string | undefined): KeyRing {
  if (!raw) throw new Error("FIELD_ENCRYPTION_KEY is not set");
  const all = new Map<string, Buffer>();
  let primary: DataKey | null = null;
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) throw new Error("FIELD_ENCRYPTION_KEY entries must look like keyId:base64");
    const id = part.slice(0, idx).trim();
    const key = decode32(part.slice(idx + 1), `FIELD_ENCRYPTION_KEY ${id}`);
    all.set(id, key);
    primary ??= { id, key };
  }
  if (!primary) throw new Error("FIELD_ENCRYPTION_KEY is empty");
  return { primary, all };
}

function wrapAad(id: string): Buffer {
  return Buffer.from(id, "utf8");
}

/** Wraps a 32-byte data key with the master key: base64(iv(12) | tag(16) | wrapped(32)). */
export function wrapDataKey(master: Buffer, id: string, dataKey: Buffer): string {
  if (!KEY_ID.test(id)) throw new Error("Data key id must be letters, digits, _ . - (max 64)");
  if (master.length !== 32 || dataKey.length !== 32) throw new Error("Keys must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, iv, { authTagLength: 16 });
  cipher.setAAD(wrapAad(id));
  const data = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

/** Unwraps one data key. Any failure names the key id only. */
export function unwrapDataKey(master: Buffer, id: string, wrapped: string): Buffer {
  const fail = () =>
    new Error(
      `Field encryption data key ${id} could not be unwrapped with the local master key ` +
        "(wrong master key, changed key id, or a damaged wrapped key)",
    );
  const buf = Buffer.from(wrapped.trim(), "base64");
  if (buf.length !== 12 + 16 + 32) throw fail();
  try {
    const decipher = createDecipheriv("aes-256-gcm", master, buf.subarray(0, 12), {
      authTagLength: 16,
    });
    decipher.setAAD(wrapAad(id));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  } catch {
    throw fail();
  }
}

/** Makes a fresh data key and returns only its wrapped form (the plain key is wiped). */
export function newWrappedDataKey(master: Buffer, id: string): string {
  const dataKey = randomBytes(32);
  try {
    return wrapDataKey(master, id, dataKey);
  } finally {
    dataKey.fill(0);
  }
}

export function staticProvider(rawKeyRing: string | undefined): FieldKeyProvider {
  return { name: "static", loadDataKeys: async () => parseStaticRing(rawKeyRing) };
}

export function localProvider(cfg: {
  masterKey: string | undefined;
  dataKeys: string | undefined;
  staticKeyRing: string | undefined;
}): FieldKeyProvider {
  return {
    name: "local",
    async loadDataKeys() {
      if (!cfg.masterKey?.trim()) {
        throw new Error("FIELD_ENCRYPTION_PROVIDER=local needs FIELD_ENCRYPTION_LOCAL_MASTER_KEY");
      }
      if (!cfg.dataKeys?.trim()) {
        throw new Error("FIELD_ENCRYPTION_PROVIDER=local needs FIELD_ENCRYPTION_DATA_KEYS");
      }
      const master = decode32(cfg.masterKey, "FIELD_ENCRYPTION_LOCAL_MASTER_KEY");
      const staticRing = parseStaticRing(cfg.staticKeyRing);
      const all = new Map<string, Buffer>();
      let primary: DataKey | null = null;
      try {
        for (const { id, value } of parseEntries(cfg.dataKeys, "FIELD_ENCRYPTION_DATA_KEYS")) {
          if (staticRing.all.has(id)) {
            throw new Error(
              `Key id ${id} is in both FIELD_ENCRYPTION_KEY and FIELD_ENCRYPTION_DATA_KEYS; ` +
                "key ids must be unique across rings",
            );
          }
          const key = unwrapDataKey(master, id, value);
          all.set(id, key);
          primary ??= { id, key };
        }
      } finally {
        master.fill(0);
      }
      // The static ring stays decrypt-only: old rows and raw channel payloads in S3 use it.
      for (const [id, key] of staticRing.all) all.set(id, key);
      if (!primary) throw new Error("FIELD_ENCRYPTION_DATA_KEYS is empty");
      return { primary, all };
    },
  };
}

export function kmsProvider(): FieldKeyProvider {
  return {
    name: "kms",
    loadDataKeys: async () => {
      throw new Error(KMS_NOT_BUILT_MESSAGE);
    },
  };
}

/** The provider configured in `env` (process.env by default). */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): FieldKeyProvider {
  const name = providerName(env.FIELD_ENCRYPTION_PROVIDER);
  assertProviderAllowed(name, {
    isProd: env.NODE_ENV === "production",
    allowMocks: env.ALLOW_MOCKS?.trim() === "true",
  });
  switch (name) {
    case "static":
      return staticProvider(env.FIELD_ENCRYPTION_KEY);
    case "local":
      return localProvider({
        masterKey: env.FIELD_ENCRYPTION_LOCAL_MASTER_KEY,
        dataKeys: env.FIELD_ENCRYPTION_DATA_KEYS,
        staticKeyRing: env.FIELD_ENCRYPTION_KEY,
      });
    case "kms":
      return kmsProvider();
  }
}
