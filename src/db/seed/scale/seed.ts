import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../client";
import {
  blankVariants,
  buyerPii,
  channelConnections,
  companies,
  DEFAULT_SHEET_SPEC,
  designFiles,
  designs,
  gangSheetBatches,
  gangSheets,
  locations,
  members,
  orderItems,
  orderItemTransitions,
  orders,
  profitLines,
  type Role,
  reprints,
  shipments,
  shippingSettings,
  stations,
  transfers,
  vendorConnections,
} from "../../schema";
import { DESERT_BLOOM_PROFILE } from "../builder";
import { rng } from "../data";
import { buildCatalog } from "./catalog";
import { type GenContext, generateDay } from "./generate";
import { insertChunked } from "./insert";
import { type ScaleProfile, staffCount } from "./profiles";

/*
 * The scale seed's database work (T-54-3). Everything is written as the owner role through the
 * injected `run` (withSystem with the new company id), as bulk inserts: no state machine, no
 * outbox, no events, no worker. One transaction per calendar day. The CLI (`index.ts`) runs the
 * env guard before this module is even loaded.
 */
export class ReplayError extends Error {}

export type SeedDeps = {
  run: <T>(fn: (tx: Tx) => Promise<T>, companyId?: string) => Promise<T>;
  /** Creates a login and returns the user id. */
  createUser: (email: string, name: string) => Promise<string>;
  now: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
};

export type ScaleSeedReport = {
  profile: string;
  companyId: string;
  now: string;
  seconds: number;
  counts: Record<string, number>;
  logins: { owner: string; password: string };
  /**
   * Floor credentials (A3.2): plaintext station tokens and PINs, for the k6 run only. They exist
   * nowhere else (the database keeps hashes) and reach no log: `writeReport` is the only sink.
   */
  floor: {
    stations: { id: string; kind: string | null; token: string }[];
    members: { email: string; role: Role; pin: string }[];
    /** Transfer ids (the QR payload) of open units, for the scan storm. */
    scanTargets: string[];
  };
};

const PIN_ROLES: readonly Role[] = ["presser", "packer", "receiver"];
const SCAN_TARGET_LIMIT = 400;

export const SCALE_PASSWORD = "demo1234!";
const CHANNELS = ["etsy", "shopify", "amazon", "tiktok", "walmart"] as const;
const ROLE_ORDER: Role[] = [
  "owner",
  "admin",
  "office",
  "designer",
  "presser",
  "packer",
  "receiver",
];
const PROFILE_SEEDS = { small: 20261014, mid: 20261015, large: 20261016 } as const;

export async function seedScaleProfile(
  profile: ScaleProfile,
  deps: SeedDeps,
): Promise<ScaleSeedReport> {
  const started = Date.now();
  const log = deps.log ?? (() => {});
  const random = rng(PROFILE_SEEDS[profile.name]);

  const existing = await deps.run((tx) =>
    tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.slug, profile.slug))
      .limit(1),
  );
  if (existing.length) {
    throw new ReplayError(
      `[seed:scale] ${profile.slug} already exists in this database; nothing was added. ` +
        "Use a fresh scratch database for another run.",
    );
  }

  /* ---- company, staff, members ---- */
  const [company] = await deps.run((tx) =>
    tx
      .insert(companies)
      .values({
        name: profile.companyName,
        slug: profile.slug,
        type: "shop",
        plan: "growth",
        timezone: "America/Phoenix",
      })
      .returning({ id: companies.id }),
  );
  if (!company) throw new Error("company insert failed");
  const companyId = company.id;
  const suffix = profile.slug.replace("seed-scale-", "");

  const staff: { userId: string; role: Role; email: string }[] = [];
  for (const role of ROLE_ORDER) {
    for (let n = 1; n <= profile.roles[role]; n++) {
      const email = `${role}${n}@seed-scale-${suffix}.test`;
      const userId = await deps.createUser(email, `Scale ${role} ${n}`);
      staff.push({ userId, role, email });
    }
  }
  if (staff.length !== staffCount(profile)) throw new Error("staff count mismatch");
  await deps.run(
    (tx) =>
      insertChunked(
        tx,
        members,
        staff.map((s) => ({
          organizationId: companyId,
          userId: s.userId,
          role: s.role,
          status: "active" as const,
        })),
      ),
    companyId,
  );

  /* ---- location, stations, vendors, channel connections, catalog ---- */
  const catalog = buildCatalog(companyId, profile, random);
  const setup = await deps.run(async (tx) => {
    const [loc] = await tx
      .insert(locations)
      .values({
        companyId,
        name: "Main Shop",
        isDefault: true,
        address: { ...DESERT_BLOOM_PROFILE.address, name: profile.companyName },
      })
      .returning({ id: locations.id });
    if (!loc) throw new Error("location insert failed");
    // A batch buy needs a ship-from address (B-481); same fake as the location, other columns default.
    await tx.insert(shippingSettings).values({
      companyId,
      fromAddress: { ...DESERT_BLOOM_PROFILE.address, name: profile.companyName },
    });
    const stationRows: (typeof stations.$inferInsert)[] = [];
    for (const kind of ["pick", "press", "qc", "pack"] as const) {
      for (let n = 1; n <= profile.stations[kind]; n++) {
        stationRows.push({
          companyId,
          locationId: loc.id,
          name: `${kind[0]?.toUpperCase()}${kind.slice(1)} ${n}`,
          kind,
        });
      }
    }
    const stationIds = await tx
      .insert(stations)
      .values(stationRows)
      .returning({ id: stations.id, kind: stations.kind });

    const vendorRows = Array.from({ length: profile.vendors }, (_, i) => ({
      companyId,
      vendorCompanyId: null,
      name: `Scale Vendor ${i + 1}`,
      email: `orders${i + 1}@scale-vendor.test`,
      status: "active" as const,
      delivery: "email" as const,
      spec: DEFAULT_SHEET_SPEC,
      isDefault: i === 0,
      turnaroundDays: 2 + i,
      acceptedAt: new Date(deps.now - 60 * 86_400_000),
    }));
    const vendorIds = await tx
      .insert(vendorConnections)
      .values(vendorRows)
      .returning({ id: vendorConnections.id });

    const connRows = await tx
      .insert(channelConnections)
      .values(
        CHANNELS.map((channel) => ({
          companyId,
          channel,
          name: `${profile.companyName} ${channel}`,
          status: "csv_only" as const,
          mode: "csv" as const,
          provider: "mock" as const,
          externalShopId: `${profile.slug}-${channel}`,
        })),
      )
      .returning({ id: channelConnections.id, channel: channelConnections.channel });
    await insertChunked(tx, designs, catalog.designRows);
    await insertChunked(tx, designFiles, catalog.designFileRows);
    await insertChunked(tx, blankVariants, catalog.blankRows);
    return {
      stationIds,
      pressStationIds: stationIds.filter((s) => s.kind === "press").map((s) => s.id),
      vendorIds: vendorIds.map((v) => v.id),
      connections: Object.fromEntries(connRows.map((c) => [c.channel, c.id])),
    };
  }, companyId);
  log("setup", {
    staff: staff.length,
    skus: catalog.skus.length,
    designs: catalog.designRows.length,
  });

  /* ---- floor logins: PINs and one station token per station (A3.1) ---- */
  const ownerId = staff.find((s) => s.role === "owner")?.userId ?? null;
  const floor = await seedFloorLogins(deps, companyId, staff, setup.stationIds, ownerId, profile);

  /* ---- order history, oldest day first ---- */
  const ctx: GenContext = {
    profile,
    now: deps.now,
    random,
    companyId,
    connections: setup.connections as GenContext["connections"],
    vendorConnectionIds: setup.vendorIds,
    pressStationIds: setup.pressStationIds,
    skus: catalog.skus,
    sheetKeys: { png: catalog.keys.sheet, preview: catalog.keys.sheetPreview },
    counters: { order: 0, sheet: 0, reprint: 0 },
  };
  for (let d = profile.historyDays - 1; d >= 0; d--) {
    const day = generateDay(ctx, d);
    await deps.run(async (tx) => {
      await insertChunked(tx, orders, day.orders);
      await insertChunked(tx, shipments, day.shipments);
      await insertChunked(tx, buyerPii, day.buyerPii);
      await insertChunked(tx, orderItems, day.items);
      await insertChunked(tx, orderItemTransitions, day.transitions);
      await insertChunked(tx, gangSheetBatches, day.batches);
      await insertChunked(tx, gangSheets, day.sheets);
      await insertChunked(tx, transfers, day.transfers);
      await insertChunked(tx, reprints, day.reprints);
      await insertChunked(tx, profitLines, day.profit);
    }, companyId);
    if (d % 10 === 0)
      log("days left", { d, orders: ctx.counters.order, sheets: ctx.counters.sheet });
  }

  floor.scanTargets = await scanTargetsFor(deps, companyId);
  const counts = await countFor(deps, companyId);
  return {
    profile: profile.name,
    companyId,
    now: new Date(deps.now).toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    counts,
    logins: { owner: `owner1@seed-scale-${suffix}.test`, password: SCALE_PASSWORD },
    floor,
  };
}

/**
 * One 6-digit PIN per presser, packer and receiver member and one live token per station,
 * through the app's own `setPin` and `issueStationToken` (hashes in the database, plaintext only
 * in the returned value). Loaded after the guard, like the demo seed does (builder.ts).
 */
async function seedFloorLogins(
  deps: SeedDeps,
  companyId: string,
  staff: { userId: string; role: Role; email: string }[],
  stationIds: { id: string; kind: string | null }[],
  ownerId: string | null,
  profile: ScaleProfile,
): Promise<ScaleSeedReport["floor"]> {
  const { setPin, issueStationToken } = await import("../../../modules/tenancy/floor-auth");
  const random = rng(PROFILE_SEEDS[profile.name] + 101);
  const used = new Set<string>();
  const members: ScaleSeedReport["floor"]["members"] = [];
  for (const s of staff.filter((x) => PIN_ROLES.includes(x.role))) {
    let pin: string;
    do pin = String(random.int(100_000, 999_999));
    while (used.has(pin));
    used.add(pin);
    members.push({ email: s.email, role: s.role, pin });
  }
  const tokens: ScaleSeedReport["floor"]["stations"] = [];
  await deps.run(async (tx) => {
    for (const m of members) {
      const userId = staff.find((s) => s.email === m.email)?.userId as string;
      await setPin(tx, { companyId, userId, pin: m.pin, actorUserId: ownerId });
    }
    for (const st of stationIds) {
      const { token } = await issueStationToken(tx, {
        companyId,
        stationId: st.id,
        userId: ownerId,
      });
      tokens.push({ id: st.id, kind: st.kind, token });
    }
  }, companyId);
  return { stations: tokens, members, scanTargets: [] };
}

/** Transfer ids of open units a station could scan (press-ready first), newest first. */
async function scanTargetsFor(deps: SeedDeps, companyId: string): Promise<string[]> {
  return deps.run(async (tx) => {
    const res = await tx.execute(
      sql`select t.id from transfers t join order_items i
            on i.company_id = t.company_id and i.id = t.order_item_id
          where t.company_id = ${companyId} and not t.scrapped
            and i.state in ('transfer_in', 'on_sheet', 'pressed')
          order by (i.state = 'transfer_in') desc, i.state_changed_at desc
          limit ${SCAN_TARGET_LIMIT}`,
    );
    return (res.rows as { id: string }[]).map((r) => r.id);
  }, companyId);
}

const COUNTED = [
  "orders",
  "order_items",
  "order_item_transitions",
  "gang_sheet_batches",
  "gang_sheets",
  "transfers",
  "reprints",
  "profit_lines",
  "designs",
  "design_files",
  "blank_variants",
  "stations",
  "vendor_connections",
  "channel_connections",
] as const;

async function countFor(deps: SeedDeps, companyId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await deps.run(async (tx) => {
    for (const t of COUNTED) {
      const res = await tx.execute(
        sql`select count(*)::int as n from ${sql.identifier(t)} where company_id = ${companyId}`,
      );
      out[t] = Number((res.rows[0] as { n: number }).n);
    }
    const m = await tx.execute(
      sql`select count(*)::int as n from members where organization_id = ${companyId}`,
    );
    out.members = Number((m.rows[0] as { n: number }).n);
  }, companyId);
  return out;
}

/** The report carries plaintext floor credentials, so the file is owner-only (A3.2). */
export function writeReport(file: string, report: ScaleSeedReport) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
