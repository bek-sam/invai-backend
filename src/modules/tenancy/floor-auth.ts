import { and, eq, isNull } from "drizzle-orm";
import { db, type Tx, withTenant } from "../../db/client";
import type { Role, StationKind } from "../../db/schema";
import { members, staffPins, stations, stationTokens, users } from "../../db/schema";
import { env } from "../../env";
import { audit } from "../../lib/audit";
import { hmacHex, randomToken, sha256Hex, signPayload, verifyPayload } from "../../lib/crypto";
import { badRequest, ORPCError, unauthorized } from "../../lib/errors";

/*
 * Floor login, two factors:
 *  1. A station token `st1.<companyId>.<random>` issued to a tablet by an owner/admin. Only
 *     its SHA-256 is stored. The company id travels in the token so the lookup can run under
 *     RLS without a cross-tenant query. Sent as `Authorization: Station <token>`.
 *  2. A 4–6 digit staff PIN, HMAC-hashed per company. Station token + PIN → a signed floor
 *     session `fs1.<payload>.<sig>` valid FLOOR_SESSION_TTL_HOURS, sent as `Authorization: Bearer`.
 */

const STATION_PREFIX = "st1";
const FLOOR_PREFIX = "fs1";

export type StationSession = {
  companyId: string;
  station: { id: string; name: string; kind: StationKind | null; active: boolean };
  tokenId: string;
};

export type FloorSessionPayload = {
  k: "floor";
  v: 1;
  uid: string;
  cid: string;
  sid: string;
  tid: string;
  role: Role;
  exp: number;
};

export type FloorSession = {
  userId: string;
  companyId: string;
  stationId: string;
  stationTokenId: string;
  role: Role;
  expiresAt: Date;
};

export function parseStationToken(token: string): { companyId: string } | null {
  const [prefix, companyId, secret] = token.split(".");
  if (prefix !== STATION_PREFIX || !companyId || !secret) return null;
  if (!/^[0-9a-f-]{36}$/.test(companyId)) return null;
  return { companyId };
}

/** Issue a new token for a station, revoking any live one. Returns the plaintext once. */
export async function issueStationToken(
  tx: Tx,
  input: { companyId: string; stationId: string; userId: string | null },
): Promise<{ token: string; tokenId: string }> {
  const token = `${STATION_PREFIX}.${input.companyId}.${randomToken(32)}`;
  await tx
    .update(stationTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(stationTokens.companyId, input.companyId),
        eq(stationTokens.stationId, input.stationId),
        isNull(stationTokens.revokedAt),
      ),
    );
  const [row] = await tx
    .insert(stationTokens)
    .values({
      companyId: input.companyId,
      stationId: input.stationId,
      tokenHash: sha256Hex(token),
      tokenPrefix: token.slice(-43, -35),
      createdBy: input.userId,
    })
    .returning({ id: stationTokens.id });
  await tx
    .update(stations)
    .set({ tokenIssuedAt: new Date() })
    .where(and(eq(stations.companyId, input.companyId), eq(stations.id, input.stationId)));
  await audit(tx, {
    companyId: input.companyId,
    actor: { kind: "user", userId: input.userId },
    action: "station.token_issued",
    entityType: "station",
    entityId: input.stationId,
    summary: "Station token issued",
  });
  if (!row) throw new Error("station token insert returned nothing");
  return { token, tokenId: row.id };
}

export async function revokeStationTokens(tx: Tx, input: { companyId: string; stationId: string }) {
  await tx
    .update(stationTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(stationTokens.companyId, input.companyId),
        eq(stationTokens.stationId, input.stationId),
        isNull(stationTokens.revokedAt),
      ),
    );
  await tx
    .update(stations)
    .set({ tokenIssuedAt: null })
    .where(and(eq(stations.companyId, input.companyId), eq(stations.id, input.stationId)));
}

/** Validate a station token. Null when unknown, revoked or malformed. */
export async function resolveStationToken(token: string): Promise<StationSession | null> {
  const parsed = parseStationToken(token);
  if (!parsed) return null;
  const hash = sha256Hex(token);
  return withTenant(parsed.companyId, async (tx) => {
    const [row] = await tx
      .select({
        tokenId: stationTokens.id,
        stationId: stations.id,
        name: stations.name,
        kind: stations.kind,
        active: stations.active,
      })
      .from(stationTokens)
      .innerJoin(stations, eq(stations.id, stationTokens.stationId))
      .where(and(eq(stationTokens.tokenHash, hash), isNull(stationTokens.revokedAt)))
      .limit(1);
    if (!row) return null;
    await tx
      .update(stationTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(stationTokens.id, row.tokenId));
    return {
      companyId: parsed.companyId,
      tokenId: row.tokenId,
      station: { id: row.stationId, name: row.name, kind: row.kind, active: row.active },
    };
  });
}

export function hashPin(companyId: string, pin: string): string {
  return hmacHex(env.FLOOR_TOKEN_SECRET, `pin:${companyId}:${pin}`);
}

/** Set (or replace) a user's PIN in one company. PINs are unique per company. */
export async function setPin(
  tx: Tx,
  input: { companyId: string; userId: string; pin: string; actorUserId: string | null },
) {
  if (!/^\d{4,6}$/.test(input.pin)) throw badRequest("PIN must be 4 to 6 digits");
  const pinHash = hashPin(input.companyId, input.pin);
  const [taken] = await tx
    .select({ userId: staffPins.userId })
    .from(staffPins)
    .where(and(eq(staffPins.companyId, input.companyId), eq(staffPins.pinHash, pinHash)))
    .limit(1);
  if (taken && taken.userId !== input.userId) throw badRequest("That PIN is already in use");
  await tx
    .insert(staffPins)
    .values({ companyId: input.companyId, userId: input.userId, pinHash, active: true })
    .onConflictDoUpdate({
      target: [staffPins.companyId, staffPins.userId],
      set: { pinHash, active: true, updatedAt: new Date() },
    });
  await audit(tx, {
    companyId: input.companyId,
    actor: { kind: "user", userId: input.actorUserId },
    action: "team.pin_set",
    entityType: "user",
    entityId: input.userId,
    summary: "Floor PIN set",
  });
}

export function createFloorSessionToken(session: Omit<FloorSession, "expiresAt">): {
  token: string;
  expiresAt: Date;
} {
  const expiresAt = new Date(Date.now() + env.FLOOR_SESSION_TTL_HOURS * 3600 * 1000);
  const payload: FloorSessionPayload = {
    k: "floor",
    v: 1,
    uid: session.userId,
    cid: session.companyId,
    sid: session.stationId,
    tid: session.stationTokenId,
    role: session.role,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  return { token: `${FLOOR_PREFIX}.${signPayload(env.FLOOR_TOKEN_SECRET, payload)}`, expiresAt };
}

/** Signature + expiry only; callers also check the station token is still live. */
export function verifyFloorSessionToken(token: string): FloorSession | null {
  if (!token.startsWith(`${FLOOR_PREFIX}.`)) return null;
  const payload = verifyPayload<FloorSessionPayload>(
    env.FLOOR_TOKEN_SECRET,
    token.slice(FLOOR_PREFIX.length + 1),
  );
  if (payload?.k !== "floor" || payload.v !== 1) return null;
  if (payload.exp * 1000 < Date.now()) return null;
  return {
    userId: payload.uid,
    companyId: payload.cid,
    stationId: payload.sid,
    stationTokenId: payload.tid,
    role: payload.role,
    expiresAt: new Date(payload.exp * 1000),
  };
}

const liveTokenCache = new Map<string, { until: number; ok: boolean }>();
const LIVE_TTL_MS = 30_000;

/** Is the station token behind a floor session still valid (not revoked, station active)? */
export async function isStationTokenLive(companyId: string, tokenId: string): Promise<boolean> {
  const cached = liveTokenCache.get(tokenId);
  if (cached && cached.until > Date.now()) return cached.ok;
  const ok = await withTenant(companyId, async (tx) => {
    const [row] = await tx
      .select({ active: stations.active })
      .from(stationTokens)
      .innerJoin(stations, eq(stations.id, stationTokens.stationId))
      .where(and(eq(stationTokens.id, tokenId), isNull(stationTokens.revokedAt)))
      .limit(1);
    return !!row?.active;
  });
  liveTokenCache.set(tokenId, { until: Date.now() + LIVE_TTL_MS, ok });
  return ok;
}

export function forgetStationToken(tokenId: string) {
  liveTokenCache.delete(tokenId);
}

export type PinLoginResult = {
  token: string;
  expiresAt: Date;
  user: { id: string; name: string; role: Role };
  station: { id: string; name: string; kind: StationKind | null };
};

/** Station token + PIN → floor session. Throws INVALID_PIN / STATION_INACTIVE style errors. */
export async function pinLogin(input: {
  stationToken: string;
  pin: string;
  ip: string | null;
}): Promise<PinLoginResult> {
  const station = await resolveStationToken(input.stationToken);
  if (!station) throw unauthorized("Station token not recognized");
  if (!station.station.active) {
    throw new ORPCError("STATION_INACTIVE", { status: 403, message: "Station is inactive" });
  }

  const pinHash = hashPin(station.companyId, input.pin);
  const found = await withTenant(station.companyId, async (tx) => {
    const [pin] = await tx
      .select({ userId: staffPins.userId })
      .from(staffPins)
      .where(and(eq(staffPins.pinHash, pinHash), eq(staffPins.active, true)))
      .limit(1);
    if (!pin) return null;
    const [member] = await db
      .select({ role: members.role, status: members.status, name: users.name })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.organizationId, station.companyId), eq(members.userId, pin.userId)))
      .limit(1);
    if (member?.status !== "active") return null;
    await audit(tx, {
      companyId: station.companyId,
      actor: { kind: "user", userId: pin.userId, stationId: station.station.id, ip: input.ip },
      action: "auth.floor_login",
      entityType: "station",
      entityId: station.station.id,
      summary: `${member.name} logged in on ${station.station.name}`,
    });
    await tx
      .update(stations)
      .set({ lastSeenAt: new Date() })
      .where(eq(stations.id, station.station.id));
    return { userId: pin.userId, name: member.name, role: member.role };
  });
  if (!found) throw new ORPCError("INVALID_PIN", { status: 401, message: "PIN not recognized" });

  const { token, expiresAt } = createFloorSessionToken({
    userId: found.userId,
    companyId: station.companyId,
    stationId: station.station.id,
    stationTokenId: station.tokenId,
    role: found.role,
  });
  return {
    token,
    expiresAt,
    user: { id: found.userId, name: found.name, role: found.role },
    station: { id: station.station.id, name: station.station.name, kind: station.station.kind },
  };
}
