import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../db/client";
import { channelConnections } from "../db/schema";
import { createCompany, createConnection } from "../test/fixtures";
import {
  decryptField,
  decryptJson,
  encryptField,
  encryptJson,
  initFieldEncryption,
  needsReencrypt,
  resetKeyRing,
} from "./crypto";
import {
  KMS_NOT_BUILT_MESSAGE,
  localProvider,
  newWrappedDataKey,
  providerFromEnv,
  unwrapDataKey,
  wrapDataKey,
} from "./field-keys";
import { runFieldKeysCli } from "./field-keys-cli";

const VARS = [
  "FIELD_ENCRYPTION_PROVIDER",
  "FIELD_ENCRYPTION_KEY",
  "FIELD_ENCRYPTION_LOCAL_MASTER_KEY",
  "FIELD_ENCRYPTION_DATA_KEYS",
  "NODE_ENV",
  "ALLOW_MOCKS",
] as const;
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));

const MASTER = randomBytes(32);
const MASTER_B64 = MASTER.toString("base64");
const DATA_KEY = randomBytes(32);
const DATA_KEY_2 = randomBytes(32);
const WRAPPED = wrapDataKey(MASTER, "d1", DATA_KEY);
const WRAPPED_2 = wrapDataKey(MASTER, "d0", DATA_KEY_2);
const STATIC_RING = saved.FIELD_ENCRYPTION_KEY as string;
/** A key whose base64 has no `+` or `/`: without its `=` it passes the key-id shape (S-66). */
const ALNUM_KEY = (() => {
  for (;;) {
    const b64 = randomBytes(32).toString("base64").replace(/=+$/, "");
    if (/^[A-Za-z0-9]+$/.test(b64)) return b64;
  }
})();

/** Every secret a message must never contain, in the encodings a leak would use. */
function secretsIn(text: string): string[] {
  const values = [MASTER, DATA_KEY, DATA_KEY_2].flatMap((b) => [
    b.toString("base64"),
    b.toString("hex"),
    b.toString("base64url"),
  ]);
  values.push(WRAPPED, WRAPPED_2, ALNUM_KEY, STATIC_RING.slice(STATIC_RING.indexOf(":") + 1));
  return values.filter((v) => text.includes(v));
}

function useLocal(extra: Record<string, string | undefined> = {}) {
  Object.assign(process.env, {
    FIELD_ENCRYPTION_PROVIDER: "local",
    FIELD_ENCRYPTION_KEY: STATIC_RING,
    FIELD_ENCRYPTION_LOCAL_MASTER_KEY: MASTER_B64,
    FIELD_ENCRYPTION_DATA_KEYS: `d1:${WRAPPED},d0:${WRAPPED_2}`,
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetKeyRing();
}

async function errorText(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  }
  throw new Error("expected a failure");
}

beforeEach(() => resetKeyRing());
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetKeyRing();
});

describe("key wrapping (AES-256-GCM, AAD = key id)", () => {
  it("round-trips and refuses a wrong master key, a changed id or a damaged blob", () => {
    expect(unwrapDataKey(MASTER, "d1", WRAPPED).equals(DATA_KEY)).toBe(true);
    expect(() => unwrapDataKey(randomBytes(32), "d1", WRAPPED)).toThrow(
      /d1 could not be unwrapped/,
    );
    expect(() => unwrapDataKey(MASTER, "d2", WRAPPED)).toThrow(/d2 could not be unwrapped/);
    const buf = Buffer.from(WRAPPED, "base64");
    buf[40] = (buf[40] ?? 0) ^ 1;
    expect(() => unwrapDataKey(MASTER, "d1", buf.toString("base64"))).toThrow(/d1/);
    expect(() => unwrapDataKey(MASTER, "d1", "c2hvcnQ=")).toThrow(/d1/);
  });

  it("newWrappedDataKey returns a fresh wrapped key that unwraps to 32 bytes", () => {
    const a = newWrappedDataKey(MASTER, "k9");
    expect(a).not.toBe(newWrappedDataKey(MASTER, "k9"));
    expect(unwrapDataKey(MASTER, "k9", a)).toHaveLength(32);
  });
});

describe("static provider (default, unchanged)", () => {
  it("works without initFieldEncryption(), with the FIELD_ENCRYPTION_KEY primary id", async () => {
    delete process.env.FIELD_ENCRYPTION_PROVIDER;
    const stored = encryptField("Jane Buyer");
    expect(stored.startsWith(`${STATIC_RING.slice(0, STATIC_RING.indexOf(":"))}:`)).toBe(true);
    expect(decryptField(stored)).toBe("Jane Buyer");
    await initFieldEncryption();
    expect(decryptField(stored)).toBe("Jane Buyer");
    expect(needsReencrypt(stored)).toBe(false);
  });

  it("a swapped or repeated entry is refused at parse, naming the entry or id only (S-66, S-67)", async () => {
    const cases: [string, string, RegExp][] = [
      [
        "swapped",
        `${DATA_KEY.toString("base64")}:k1`,
        /^FIELD_ENCRYPTION_KEY entry 1 has an invalid key id/,
      ],
      [
        "swapped, unpadded",
        `${ALNUM_KEY}:k1`,
        /^FIELD_ENCRYPTION_KEY entry 1 has an invalid key id/,
      ],
      [
        "key in the id position, key as value",
        `${ALNUM_KEY}:${DATA_KEY.toString("base64")}`,
        /^FIELD_ENCRYPTION_KEY entry 1 has an invalid key id/,
      ],
      [
        "swapped second entry",
        `k2:${DATA_KEY_2.toString("base64")},${MASTER_B64}:k1`,
        /^FIELD_ENCRYPTION_KEY entry 2 has an invalid key id/,
      ],
      [
        "repeated id",
        `k9:${DATA_KEY.toString("base64")},k9:${DATA_KEY_2.toString("base64")}`,
        /^FIELD_ENCRYPTION_KEY lists key id k9 twice\n/,
      ],
    ];
    for (const [label, ring, expected] of cases) {
      delete process.env.FIELD_ENCRYPTION_PROVIDER;
      process.env.FIELD_ENCRYPTION_KEY = ring;
      resetKeyRing();
      for (const text of [
        await errorText(() => encryptField("x")),
        await errorText(() => decryptField("k9:AAAA")),
      ]) {
        expect(text, label).toMatch(expected);
        expect(secretsIn(text), label).toEqual([]);
      }
    }
  });

  it("init is memoized: the same promise every time until resetKeyRing()", () => {
    const p = initFieldEncryption();
    expect(initFieldEncryption()).toBe(p);
    resetKeyRing();
    expect(initFieldEncryption()).not.toBe(p);
  });
});

describe("local provider", () => {
  it("encrypts with the first data key and still reads values written under the static ring", async () => {
    delete process.env.FIELD_ENCRYPTION_PROVIDER;
    const old = encryptJson({ token: "abc" });
    useLocal();
    await initFieldEncryption();
    const fresh = encryptField("123 Main St");
    expect(fresh.startsWith("d1:")).toBe(true);
    expect(decryptField(fresh)).toBe("123 Main St");
    expect(decryptJson(old)).toEqual({ token: "abc" });
    expect(needsReencrypt(old)).toBe(true);
    expect(needsReencrypt(fresh)).toBe(false);
  });

  it("fails closed before init: encrypt and decrypt throw, never use the static key", async () => {
    delete process.env.FIELD_ENCRYPTION_PROVIDER;
    const old = encryptField("x");
    useLocal();
    expect(() => encryptField("y")).toThrow(/not initialised/);
    expect(() => decryptField(old)).toThrow(/not initialised/);
    expect(() => needsReencrypt(old)).toThrow(/not initialised/);
  });

  it("resetKeyRing() forgets the provider ring: back to fail-closed until init runs again", async () => {
    useLocal();
    await initFieldEncryption();
    expect(encryptField("a").startsWith("d1:")).toBe(true);
    resetKeyRing();
    expect(() => encryptField("a")).toThrow(/not initialised/);
  });

  it("refuses a key id present in both rings, and duplicate data key ids", async () => {
    const staticId = STATIC_RING.slice(0, STATIC_RING.indexOf(":"));
    const clash = wrapDataKey(MASTER, staticId, DATA_KEY);
    useLocal({ FIELD_ENCRYPTION_DATA_KEYS: `${staticId}:${clash}` });
    await expect(initFieldEncryption()).rejects.toThrow(/in both FIELD_ENCRYPTION_KEY/);
    useLocal({ FIELD_ENCRYPTION_DATA_KEYS: `d1:${WRAPPED},d1:${WRAPPED}` });
    await expect(initFieldEncryption()).rejects.toThrow(/key id d1 twice/);
  });

  it("each start failure names the key id at most, never key material (AC 3, AC 6)", async () => {
    const tampered = Buffer.from(WRAPPED, "base64");
    tampered[30] = (tampered[30] ?? 0) ^ 1;
    const cases: [string, Record<string, string | undefined>, RegExp][] = [
      [
        "wrong master",
        { FIELD_ENCRYPTION_LOCAL_MASTER_KEY: randomBytes(32).toString("base64") },
        /d1 could not be unwrapped/,
      ],
      [
        "tampered blob",
        { FIELD_ENCRYPTION_DATA_KEYS: `d1:${tampered.toString("base64")}` },
        /d1 could not be unwrapped/,
      ],
      [
        "wrong AAD (relabelled)",
        { FIELD_ENCRYPTION_DATA_KEYS: `d7:${WRAPPED}` },
        /d7 could not be unwrapped/,
      ],
      [
        "short master",
        { FIELD_ENCRYPTION_LOCAL_MASTER_KEY: MASTER.subarray(0, 16).toString("base64") },
        /must decode to 32 bytes/,
      ],
      [
        "no master",
        { FIELD_ENCRYPTION_LOCAL_MASTER_KEY: undefined },
        /needs FIELD_ENCRYPTION_LOCAL_MASTER_KEY/,
      ],
      [
        "no data keys",
        { FIELD_ENCRYPTION_DATA_KEYS: undefined },
        /needs FIELD_ENCRYPTION_DATA_KEYS/,
      ],
      ["missing id", { FIELD_ENCRYPTION_DATA_KEYS: WRAPPED }, /keyId:base64/],
      // S-66: a swapped entry (`<key>:k1`) on either ring names the entry number only.
      [
        "swapped static entry",
        { FIELD_ENCRYPTION_KEY: `${DATA_KEY.toString("base64")}:k1` },
        /^FIELD_ENCRYPTION_KEY entry 1 has an invalid key id/,
      ],
      [
        "swapped static entry, unpadded key",
        { FIELD_ENCRYPTION_KEY: `k0:${DATA_KEY_2.toString("base64")},${ALNUM_KEY}:k1` },
        /^FIELD_ENCRYPTION_KEY entry 2 has an invalid key id/,
      ],
      [
        "swapped data key entry",
        { FIELD_ENCRYPTION_DATA_KEYS: `d0:${WRAPPED_2},${WRAPPED}:d1` },
        /^FIELD_ENCRYPTION_DATA_KEYS entry 2 has an invalid key id/,
      ],
      [
        "swapped data key entry, unpadded key",
        { FIELD_ENCRYPTION_DATA_KEYS: `${ALNUM_KEY}:d1` },
        /^FIELD_ENCRYPTION_DATA_KEYS entry 1 has an invalid key id/,
      ],
      [
        "key-shaped id on both rings",
        {
          FIELD_ENCRYPTION_KEY: `${ALNUM_KEY}:${DATA_KEY.toString("base64")}`,
          FIELD_ENCRYPTION_DATA_KEYS: `${ALNUM_KEY}:${WRAPPED}`,
        },
        /^FIELD_ENCRYPTION_KEY entry 1 has an invalid key id/,
      ],
      // S-67: a repeated static id is refused by id.
      [
        "repeated static id",
        {
          FIELD_ENCRYPTION_KEY: `k9:${DATA_KEY.toString("base64")},k9:${DATA_KEY_2.toString("base64")}`,
        },
        /^FIELD_ENCRYPTION_KEY lists key id k9 twice\n/,
      ],
    ];
    for (const [label, extra, expected] of cases) {
      useLocal(extra);
      const text = await errorText(() => initFieldEncryption());
      expect(text, label).toMatch(expected);
      expect(secretsIn(text), label).toEqual([]);
      // The sync path after a failed init still refuses, and its message leaks nothing either.
      const sync = await errorText(() => encryptField("x"));
      expect(sync, label).toMatch(/not initialised/);
      expect(secretsIn(sync), label).toEqual([]);
    }
  });

  it("is refused in production unless ALLOW_MOCKS=true", async () => {
    useLocal({ NODE_ENV: "production" });
    await expect(initFieldEncryption()).rejects.toThrow(/FIELD_ENCRYPTION_PROVIDER=local/);
    useLocal({ NODE_ENV: "production", ALLOW_MOCKS: "true" });
    await initFieldEncryption();
    expect(encryptField("z").startsWith("d1:")).toBe(true);
  });

  it("the provider can be built directly, as a KMS adapter will be (one file, same ring)", async () => {
    const ring = await localProvider({
      masterKey: MASTER_B64,
      dataKeys: `d1:${WRAPPED}`,
      staticKeyRing: STATIC_RING,
    }).loadDataKeys();
    expect(ring.primary.id).toBe("d1");
    expect([...ring.all.keys()].sort()).toEqual(
      ["d1", ...STATIC_RING.split(",").map((p) => p.slice(0, p.indexOf(":")))].sort(),
    );
  });
});

describe("kms and unknown providers", () => {
  it("kms refuses at init with one line naming B-327 and the static fallback", async () => {
    process.env.FIELD_ENCRYPTION_PROVIDER = "kms";
    resetKeyRing();
    await expect(initFieldEncryption()).rejects.toThrow(KMS_NOT_BUILT_MESSAGE);
    expect(KMS_NOT_BUILT_MESSAGE).toMatch(/B-327/);
    expect(KMS_NOT_BUILT_MESSAGE).toMatch(/FIELD_ENCRYPTION_PROVIDER=static/);
    expect(KMS_NOT_BUILT_MESSAGE).not.toContain("\n");
    expect(() => encryptField("x")).toThrow(/not initialised/);
  });

  it("a typo never falls back to static", async () => {
    process.env.FIELD_ENCRYPTION_PROVIDER = "lcoal";
    resetKeyRing();
    expect(() => encryptField("x")).toThrow(/must be one of static, local, kms/);
    expect(() => providerFromEnv()).toThrow(/must be one of/);
    await expect(initFieldEncryption()).rejects.toThrow(/must be one of/);
  });
});

describe("scoped() initialises the ring itself (AC 8)", () => {
  it("withTenant reads static-ring rows and writes data-key rows with no explicit init", async () => {
    delete process.env.FIELD_ENCRYPTION_PROVIDER;
    resetKeyRing();
    const company = await createCompany();
    const conn = await createConnection(company.id);
    await withTenant(company.id, (tx) =>
      tx
        .update(channelConnections)
        .set({ credentials: "static-secret" })
        .where(eq(channelConnections.id, conn.id)),
    );

    useLocal(); // no initFieldEncryption() call: scoped() must do it
    const [read] = await withTenant(company.id, (tx) =>
      tx
        .select({ c: channelConnections.credentials })
        .from(channelConnections)
        .where(eq(channelConnections.id, conn.id)),
    );
    expect(read?.c).toBe("static-secret");
    const second = await createConnection(company.id);
    await withTenant(company.id, (tx) =>
      tx
        .update(channelConnections)
        .set({ credentials: "local-secret" })
        .where(eq(channelConnections.id, second.id)),
    );
    const raw = await withSystem((tx) =>
      tx.execute<{ id: string; credentials: string }>(
        sql`select id, credentials from channel_connections where company_id = ${company.id}`,
      ),
    );
    const byId = new Map(raw.rows.map((r) => [r.id, r.credentials]));
    expect(
      byId.get(conn.id)?.startsWith(`${STATIC_RING.slice(0, STATIC_RING.indexOf(":"))}:`),
    ).toBe(true);
    expect(byId.get(second.id)?.startsWith("d1:")).toBe(true);
  });

  it("with kms, every scoped transaction fails closed with the kms message", async () => {
    process.env.FIELD_ENCRYPTION_PROVIDER = "kms";
    resetKeyRing();
    await expect(withSystem(async () => 1)).rejects.toThrow(/B-327/);
  });
});

describe("field-keys-cli new-data-key", () => {
  function run(argv: string[], env: NodeJS.ProcessEnv) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runFieldKeysCli(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("prints only <id>:<wrapped>, which unwraps with the master key", () => {
    const res = run(["new-data-key", "--id", "d5"], {
      FIELD_ENCRYPTION_LOCAL_MASTER_KEY: MASTER_B64,
      FIELD_ENCRYPTION_KEY: STATIC_RING,
    });
    expect(res.code).toBe(0);
    const [id, wrapped] = res.out.split(":") as [string, string];
    expect(id).toBe("d5");
    expect(unwrapDataKey(MASTER, "d5", wrapped)).toHaveLength(32);
    expect(res.out.split("\n")).toHaveLength(1);
    expect(secretsIn(res.out + res.err)).toEqual([]);
  });

  it("refuses bad usage, a missing or short master key, a bad id and a static-ring id", () => {
    const staticId = STATIC_RING.slice(0, STATIC_RING.indexOf(":"));
    expect(run(["new-data-key"], {}).code).toBe(2);
    expect(run(["new-data-key", "--id", "d5"], {}).err).toMatch(/LOCAL_MASTER_KEY is not set/);
    const short = run(["new-data-key", "--id", "d5"], {
      FIELD_ENCRYPTION_LOCAL_MASTER_KEY: MASTER.subarray(0, 8).toString("base64"),
    });
    expect(short.err).toMatch(/32 bytes/);
    const badId = run(["new-data-key", "--id", "a:b"], {
      FIELD_ENCRYPTION_LOCAL_MASTER_KEY: MASTER_B64,
    });
    expect(badId.code).toBe(1);
    expect(badId.out).toBe("");
    const clash = run(["new-data-key", "--id", staticId], {
      FIELD_ENCRYPTION_LOCAL_MASTER_KEY: MASTER_B64,
      FIELD_ENCRYPTION_KEY: STATIC_RING,
    });
    expect(clash.err).toMatch(/already in FIELD_ENCRYPTION_KEY/);
    for (const r of [short, badId, clash]) expect(secretsIn(r.out + r.err)).toEqual([]);
  });
});
