import { CHANNEL_RULES, type OrderItemState } from "@invai/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { systemContext } from "../../api/context";
import { imaging } from "../../integrations/imaging/client";
import { logger } from "../../lib/log";
import { bulkImportBlanks, createDesign, createProduct } from "../../modules/catalog/service";
import { recordListingsForCompany } from "../../modules/channels/sku";
import { shelfFor } from "../../modules/inventory/shelves";
import { transitionItem } from "../../modules/orders/state-machine";
import { renderValues } from "../../modules/personalization/service";
import { HEADER_HEIGHT_IN, LABEL_HEIGHT_IN } from "../../modules/production/sheets";
import { issueStationToken, setPin } from "../../modules/tenancy/floor-auth";
import type { Tx } from "../client";
import type { Address, SheetSpec } from "../schema";
import {
  adSpend,
  alerts,
  blankVariants,
  buyerPii,
  channelConnections,
  costSettings,
  DEFAULT_SHEET_SPEC,
  designFiles,
  gangSheetBatches,
  gangSheets,
  inventoryMovements,
  inventorySettings,
  locations,
  orderItems,
  orders,
  packagePresets,
  personalizationTemplates,
  reprints,
  scans,
  shipments,
  shippingSettings,
  skuRules,
  stations,
  stockLevels,
  suppliers,
  transfers,
  usage,
  users,
  vendorAccess,
  vendorConnections,
} from "../schema";
import {
  BLANK_STYLES,
  CITIES,
  DESIGNS,
  FIRST_NAMES,
  LAST_NAMES,
  PERSONALIZATION_ANSWERS,
  type rng,
  SIZES,
  STREETS,
  TEMPLATES,
} from "./data";
import { holdOutbox, releaseOutbox } from "./outbox-hold";

/*
 * The reusable shop-data builder behind `pnpm db:seed` (Desert Bloom Tees) and tenancy.demo (a
 * user's sample-data workspace). It fills ONE existing shop company: location, stations,
 * settings, vendor, channels, blanks, designs, products, SKU rules, orders walked through the
 * real state machine, gang sheets, shipments, the inventory ledger, listings, ad spend, usage
 * and alerts. Users, members and the company row are the caller's.
 *
 * Everything random comes from `opts.random`, so the same seed and volumes give the same data
 * (the full seed passes the same PRNG and volumes it always used, and its output is unchanged).
 * Every write goes through `opts.run`: `withSystem(fn, companyId)` in the seed script,
 * `withTenant(companyId, fn)` for a demo, so a demo is written under the tenant's RLS.
 */

const log = logger("seed");
const DAY = 86_400_000;
const HOUR = 3_600_000;

export type Rng = ReturnType<typeof rng>;
type Runner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export type ShopProfile = {
  locationName: string;
  address: Address;
  channelNames: { shopify: string; etsy: string; amazon: string; tiktok: string };
  /** The Shopify store domain. A connected store is unique across companies (webhooks route by it). */
  shopifyDomain: string;
  adCampaign: string;
};

export const DESERT_BLOOM_PROFILE: ShopProfile = {
  locationName: "Main Shop",
  address: {
    name: "Desert Bloom Tees",
    company: "Desert Bloom Tees LLC",
    street1: "2140 E Camelback Rd",
    street2: "Suite 110",
    city: "Phoenix",
    state: "AZ",
    zip: "85016",
    country: "US",
    phone: "602-555-0142",
    email: "hello@desertbloom.test",
  },
  channelNames: {
    shopify: "Desert Bloom Tees",
    etsy: "DesertBloomTees",
    amazon: "Desert Bloom Tees (US)",
    tiktok: "desertbloomtees",
  },
  shopifyDomain: "desert-bloom-tees.myshopify.com",
  adCampaign: "Meta – Desert Bloom",
};

export type ShopSeedOptions = {
  companyId: string;
  random: Rng;
  /** Runs one transaction for this company (tenant-scoped for a demo). */
  run: Runner;
  /**
   * Backdates the order timelines so they read naturally. `order_item_transitions` is
   * append-only for the app role, so this needs the owner connection (see backdateTimelines).
   * Omit it to keep the real insert times.
   */
  runHistory?: Runner;
  profile: ShopProfile;
  /** Who did what on the timeline (the same user may fill every slot). */
  people: { owner: string; office: string; presser: string; packer: string; receiver: string };
  /**
   * Floor PINs to set (the full seed's staff); none for a demo. `locale` sets the user's
   * `locale` column (e.g. Spanish-speaking floor staff), defaulting to "en" when omitted.
   */
  pins: { userId: string; pin: string; locale?: "en" | "es" }[];
  /** Issue a station token for "Press 1" (the full seed prints it for the floor app). */
  issueStationToken: boolean;
  /** The DTF vendor: a portal vendor org, or null for email delivery. */
  vendor: { vendorCompanyId: string | null; name: string; email: string };
  volume: { historicalOrders: number; dueSoonOrders: number; adSpendDays: number };
  /** Imaging renders (each only when imaging is up): design art, personalized artwork, sheet files. */
  render: { designs: boolean; artwork: boolean; sheets: boolean };
};

export type ShopSeedResult = {
  locationId: string;
  stationToken: string | null;
  channels: Record<string, string>;
  sheets: number;
};

/** The full Desert Bloom volumes. A demo uses a smaller slice of the same shape. */
export const FULL_VOLUME = { historicalOrders: 300, dueSoonOrders: 60, adSpendDays: 30 };

type NestItemLike = { id: string; widthIn: number; heightIn: number };
type SheetPlan<T> = {
  lengthIn: number;
  utilization: number;
  placements: { item: T; xIn: number; yIn: number; rotated: boolean }[];
};

/**
 * Fallback only (T-13-5, B-111): imaging's real `/nest` (with rotation) is what the product
 * actually builds gang sheets with, so seeded sheets go through it too — this first-fit-decreasing
 * shelf pack (sort widest first, place each item in the first already-open row it fits before
 * opening a new one, so a later narrower item can backfill a wide item's leftover width) only
 * runs if imaging is unreachable, so the seed can still finish. It never rotates.
 */
function ffdPack<T extends NestItemLike>(items: T[], spec: SheetSpec): SheetPlan<T> {
  const { marginIn, spacingIn, widthIn: filmIn } = spec;
  const usableIn = filmIn - 2 * marginIn;
  const order = items
    .map((_, i) => i)
    .sort((a, b) => (items[b]?.widthIn ?? 0) - (items[a]?.widthIn ?? 0));
  type Row = { usedIn: number; heightIn: number; items: number[] };
  const rows: Row[] = [];
  for (const idx of order) {
    const it = items[idx] as T;
    const row = rows.find((r) => r.usedIn + spacingIn + it.widthIn <= usableIn);
    if (row) {
      row.usedIn += spacingIn + it.widthIn;
      row.heightIn = Math.max(row.heightIn, it.heightIn);
      row.items.push(idx);
    } else {
      rows.push({ usedIn: it.widthIn, heightIn: it.heightIn, items: [idx] });
    }
  }
  const xy: { xIn: number; yIn: number }[] = new Array(items.length);
  let y = marginIn + HEADER_HEIGHT_IN;
  let printArea = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] as Row;
    let x = marginIn;
    for (const idx of row.items) {
      const it = items[idx] as T;
      xy[idx] = { xIn: Math.round(x * 100) / 100, yIn: Math.round(y * 100) / 100 };
      x += it.widthIn + spacingIn;
      printArea += it.widthIn * it.heightIn;
    }
    if (r < rows.length - 1) y += row.heightIn + LABEL_HEIGHT_IN + spacingIn;
  }
  const lastH = rows.length > 0 ? (rows[rows.length - 1] as Row).heightIn : 0;
  const lengthIn = Math.round((y + lastH + LABEL_HEIGHT_IN + marginIn) * 100) / 100;
  return {
    lengthIn,
    utilization: lengthIn > 0 ? Math.round((printArea / (filmIn * lengthIn)) * 100) / 100 : 0,
    placements: items.map((it, idx) => ({
      item: it,
      xIn: xy[idx]?.xIn ?? marginIn,
      yIn: xy[idx]?.yIn ?? 0,
      rotated: false,
    })),
  };
}

export async function buildShopData(opts: ShopSeedOptions): Promise<ShopSeedResult> {
  const { companyId: shopId, random, profile, people, vendor } = opts;
  // Each phase parks the outbox events it emitted before committing (see ./outbox-hold.ts), so a
  // running worker can't act on a half-built company; the last step below releases them all.
  const run: Runner = (fn) =>
    opts.run(async (tx) => {
      const out = await fn(tx);
      await holdOutbox(tx, shopId);
      return out;
    });
  const ctx = systemContext(shopId);
  const ownerId = people.owner;

  /* ---- locations, stations, PINs, station token ---- */
  const { locationId, stationToken, stationIds } = await run(async (tx) => {
    const [main] = await tx
      .insert(locations)
      .values({
        companyId: shopId,
        name: profile.locationName,
        isDefault: true,
        address: profile.address,
      })
      .returning();
    if (!main) throw new Error("location");
    const stationRows = await tx
      .insert(stations)
      .values([
        { companyId: shopId, locationId: main.id, name: "Pick 1", kind: "pick" },
        { companyId: shopId, locationId: main.id, name: "Press 1", kind: "press" },
        { companyId: shopId, locationId: main.id, name: "Press 2", kind: "press" },
        { companyId: shopId, locationId: main.id, name: "QC 1", kind: "qc" },
        { companyId: shopId, locationId: main.id, name: "Pack 1", kind: "pack" },
      ])
      .returning();
    for (const p of opts.pins) {
      await setPin(tx, { companyId: shopId, userId: p.userId, pin: p.pin, actorUserId: ownerId });
      if (p.locale) await tx.update(users).set({ locale: p.locale }).where(eq(users.id, p.userId));
    }
    const press1 = stationRows.find((s) => s.name === "Press 1");
    if (!press1) throw new Error("station");
    const token = opts.issueStationToken
      ? (await issueStationToken(tx, { companyId: shopId, stationId: press1.id, userId: ownerId }))
          .token
      : null;
    return {
      locationId: main.id,
      stationToken: token,
      stationIds: Object.fromEntries(stationRows.map((s) => [s.name, s.id])),
    };
  });

  /* ---- settings, suppliers, vendor, channels ---- */
  const channels = await run(async (tx) => {
    await tx.insert(costSettings).values({
      companyId: shopId,
      feeTables: (["etsy", "amazon", "shopify", "tiktok", "walmart"] as const)
        .map((c) => ({ channel: c, ...CHANNEL_RULES[c].fees, note: undefined }))
        .map(({ note: _n, ...rest }) => rest),
      transferCentsPerSqIn: 3,
      packagingPerOrderCents: 45,
      laborRatePerHourCents: 1800,
      laborMinutesPerItem: 4,
    });
    await tx.insert(shippingSettings).values({
      companyId: shopId,
      fromAddress: profile.address,
      weightPerStyle: [],
      defaultStrategy: "cheapest_on_time",
      allowedCarriers: ["usps", "ups", "mock"],
      labelFormat: "pdf",
      trackingPushEnabled: true,
    });
    await tx.insert(packagePresets).values([
      {
        companyId: shopId,
        name: "Poly mailer 10x13",
        lengthIn: 10,
        widthIn: 13,
        heightIn: 1,
        tareOz: 0.5,
        maxUnits: 3,
        isDefault: true,
      },
      {
        companyId: shopId,
        name: "Box 12x9x4",
        lengthIn: 12,
        widthIn: 9,
        heightIn: 4,
        tareOz: 4,
        maxUnits: 10,
        isDefault: false,
      },
    ]);
    await tx.insert(inventorySettings).values({ companyId: shopId });
    await tx.insert(suppliers).values({
      companyId: shopId,
      supplier: "ssactivewear",
      name: "S&S Activewear",
      accountNumber: "SS-448210",
      freeFreightThresholdCents: 20000,
    });
    await tx.insert(vendorConnections).values({
      companyId: shopId,
      vendorCompanyId: vendor.vendorCompanyId,
      name: vendor.name,
      email: vendor.email,
      status: "active",
      delivery: vendor.vendorCompanyId ? "portal" : "email",
      spec: DEFAULT_SHEET_SPEC,
      isDefault: true,
      turnaroundDays: 2,
      acceptedAt: new Date(Date.now() - 20 * DAY),
    });
    const rows = await tx
      .insert(channelConnections)
      .values([
        {
          companyId: shopId,
          channel: "shopify",
          name: profile.channelNames.shopify,
          status: "connected",
          mode: "api",
          provider: "mock",
          externalShopId: profile.shopifyDomain,
          connectedAt: new Date(Date.now() - 25 * DAY),
          lastPollAt: new Date(Date.now() - 4 * 60_000),
          lastWebhookAt: new Date(Date.now() - 40 * 60_000),
        },
        {
          companyId: shopId,
          channel: "etsy",
          name: profile.channelNames.etsy,
          status: "csv_only",
          mode: "csv",
          provider: "mock",
          externalShopId: "DesertBloomTees",
          lastImportAt: new Date(Date.now() - 3 * HOUR),
        },
        {
          companyId: shopId,
          channel: "amazon",
          name: profile.channelNames.amazon,
          status: "csv_only",
          mode: "csv",
          provider: "mock",
          externalShopId: "A2DESERTBLOOM",
          lastImportAt: new Date(Date.now() - 5 * HOUR),
        },
        {
          companyId: shopId,
          channel: "tiktok",
          name: profile.channelNames.tiktok,
          status: "csv_only",
          mode: "csv",
          provider: "mock",
          externalShopId: "7495012",
          lastImportAt: new Date(Date.now() - 6 * HOUR),
        },
      ])
      .returning();
    return Object.fromEntries(rows.map((r) => [r.channel, r.id])) as Record<string, string>;
  });

  /* ---- blanks ---- */
  const blankReport = await run((tx) =>
    bulkImportBlanks(tx, ctx, {
      rows: BLANK_STYLES.flatMap((style) =>
        style.colors.flatMap((color) =>
          SIZES.map((size, i) => ({
            brand: style.brand,
            style: style.style,
            styleCode: style.styleCode,
            styleName: style.styleName,
            color: color.name,
            colorCode: color.code,
            colorHex: color.hex,
            size: size.size,
            sizeCode: size.code,
            supplier: "ssactivewear" as const,
            supplierSku: `${style.supplierPrefix}${color.ss}${String(i + 1).padStart(2, "0")}`,
            cost: style.baseCostCents + size.upcharge,
            weightOz: Math.round((style.baseWeightOz + size.weightAdd) * 10) / 10,
          })),
        ),
      ),
    }),
  );
  const blanks = await run((tx) =>
    tx.select().from(blankVariants).where(eq(blankVariants.companyId, shopId)),
  );
  await run((tx) =>
    tx
      .update(blankVariants)
      .set({ reorderPoint: 8, reorderQty: 24 })
      .where(eq(blankVariants.companyId, shopId)),
  );
  log.info("blanks", blankReport);

  /* ---- personalization templates + designs (sample art via imaging) ---- */
  const templateIds = await run(async (tx) => {
    const rows = await tx
      .insert(personalizationTemplates)
      .values(
        TEMPLATES.map((t) => ({
          companyId: shopId,
          name: t.name,
          widthIn: t.widthIn,
          heightIn: t.heightIn,
          dpi: 300,
          slots: t.slots,
        })),
      )
      .returning({ id: personalizationTemplates.id });
    return rows.map((r) => r.id);
  });

  const imagingUp = opts.render.designs && (await imaging.isUp());
  if (!imagingUp)
    log.warn("imaging is down: designs get placeholder file keys (no sample art rendered)");
  const designIds = new Map<string, string>();
  for (const d of DESIGNS) {
    const fileKey = `${shopId}/design/seed/${d.code.toLowerCase()}.png`;
    let rendered = false;
    if (imagingUp) {
      try {
        await imaging.sampleArt({
          text: d.name,
          out_key: fileKey,
          width_in: d.size.widthIn,
          height_in: d.size.heightIn,
          color_hex: d.color,
        });
        rendered = true;
      } catch (err) {
        log.warn("sample art failed", { design: d.code, error: String(err) });
      }
    }
    const created = await run(async (tx) => {
      const design = await createDesign(tx, ctx, {
        code: d.code,
        name: d.name,
        tags: d.tags,
        placements: [
          {
            placement: d.size.placement,
            fileKey,
            widthIn: d.size.widthIn,
            heightIn: d.size.heightIn,
          },
        ],
        personalizationTemplateId:
          d.template === undefined ? null : (templateIds[d.template] ?? null),
      });
      if (rendered) {
        await tx
          .update(designFiles)
          .set({
            qaStatus: "passed",
            widthPx: Math.round(d.size.widthIn * 300),
            heightPx: Math.round(d.size.heightIn * 300),
            effectiveDpi: 300,
            qaCheckedAt: new Date(),
          })
          .where(eq(designFiles.designId, design.id));
      }
      return design;
    });
    designIds.set(d.code, created.id);
  }
  log.info("designs", { count: DESIGNS.length, sampleArt: imagingUp });

  /* ---- products + SKU rules ---- */
  await run(async (tx) => {
    for (const d of DESIGNS) {
      const designId = designIds.get(d.code) as string;
      const gildan = BLANK_STYLES[0];
      if (!gildan) throw new Error("no styles");
      await createProduct(tx, ctx, {
        designId,
        brand: gildan.brand,
        styleCode: gildan.styleCode,
        name: `${d.name} – Softstyle Tee`,
        allowedColorCodes: gildan.colors.map((c) => c.code),
        allowedSizeCodes: SIZES.map((s) => s.code),
        defaultPlacements: ["front"],
        prices: [
          { channel: "etsy", price: 2499 },
          { channel: "shopify", price: 2800 },
          { channel: "amazon", price: 2699 },
          { channel: "tiktok", price: 2299 },
        ],
      });
      if (Number.parseInt(d.code.slice(2), 10) % 3 === 0) {
        const cc = BLANK_STYLES[1];
        if (!cc) throw new Error("no styles");
        await createProduct(tx, ctx, {
          designId,
          brand: cc.brand,
          styleCode: cc.styleCode,
          name: `${d.name} – Comfort Colors Tee`,
          allowedColorCodes: cc.colors.map((c) => c.code),
          allowedSizeCodes: SIZES.map((s) => s.code),
          defaultPlacements: ["front"],
          prices: [
            { channel: "etsy", price: 3299 },
            { channel: "shopify", price: 3600 },
          ],
        });
      }
    }
    await tx.insert(skuRules).values([
      {
        companyId: shopId,
        name: "Standard SKU",
        patternType: "template",
        pattern: "{design}-{style}-{color}-{size}",
        channel: null,
        target: { kind: "resolve", defaults: {} },
        priority: 10,
        source: "manual",
        matchCount: 0,
      },
      {
        companyId: shopId,
        name: "Legacy Etsy saguaro",
        patternType: "exact",
        pattern: "SAGUARO-BLK-M",
        channel: "etsy",
        target: {
          kind: "direct",
          designId: designIds.get("DB001") as string,
          blankVariantId: blanks.find((b) => b.sku === "G64000-BLK-M")?.id as string,
        },
        priority: 100,
        source: "learned",
        matchCount: 14,
      },
      {
        companyId: shopId,
        name: "Legacy Etsy saguaro L",
        patternType: "exact",
        pattern: "SAGUARO-BLK-L",
        channel: "etsy",
        target: {
          kind: "direct",
          designId: designIds.get("DB001") as string,
          blankVariantId: blanks.find((b) => b.sku === "G64000-BLK-L")?.id as string,
        },
        priority: 100,
        source: "learned",
        matchCount: 9,
      },
    ]);
  });

  /* ---- orders ---- */
  const now = Date.now();
  const startOfToday = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const channelWeights: [string, number][] = [
    ["etsy", 0.4],
    ["shopify", 0.25],
    ["amazon", 0.2],
    ["tiktok", 0.15],
  ];
  const pickChannel = () => {
    const r = random.next();
    let acc = 0;
    for (const [ch, w] of channelWeights) {
      acc += w;
      if (r < acc) return ch;
    }
    return "etsy";
  };
  const orderNoFor = (channel: string, i: number) =>
    channel === "shopify"
      ? `#${1201 + i}`
      : channel === "etsy"
        ? String(3104000000 + i * 37)
        : channel === "amazon"
          ? `113-${String(2000000 + i * 911).slice(0, 7)}-${String(1000000 + i * 13).slice(0, 7)}`
          : `5763${String(100000000 + i * 7)}`;

  type Plan = {
    placedAt: Date;
    shipBy: Date;
    channel: string;
    finalState: OrderItemState;
    hold?: boolean;
    cancel?: boolean;
    qcFail?: boolean;
  };
  const plans_: Plan[] = [];
  for (let i = 0; i < opts.volume.historicalOrders; i++) {
    const ageDays = random.next() * 30;
    const placedAt = new Date(now - ageDays * DAY - random.int(0, 12) * HOUR);
    const channel = pickChannel();
    const shipBy = new Date(
      placedAt.getTime() +
        CHANNEL_RULES[channel as keyof typeof CHANNEL_RULES].shipBy.defaultDays * DAY,
    );
    let finalState: OrderItemState;
    let hold = false;
    let cancel = false;
    if (ageDays > 7) {
      const r = random.next();
      finalState = r < 0.86 ? "delivered" : r < 0.96 ? "shipped" : "cancelled";
    } else if (ageDays > 3) {
      const r = random.next();
      finalState =
        r < 0.55
          ? "shipped"
          : r < 0.75
            ? "delivered"
            : r < 0.87
              ? "packed"
              : r < 0.94
                ? "on_hold"
                : "cancelled";
    } else {
      finalState = random.pick([
        "ready",
        "ready",
        "on_sheet",
        "on_sheet",
        "transfer_in",
        "pressed",
        "packed",
        "needs_mapping",
        "needs_artwork",
        "shipped",
      ] as const);
    }
    if (finalState === "on_hold") hold = true;
    if (finalState === "cancelled") cancel = true;
    plans_.push({
      placedAt,
      shipBy,
      channel,
      finalState,
      hold,
      cancel,
      qcFail: random.chance(0.03),
    });
  }
  // Open orders due today or tomorrow (60 in the full seed).
  for (let i = 0; i < opts.volume.dueSoonOrders; i++) {
    const channel = pickChannel();
    const dueTomorrow = i % 2 === 1;
    const shipBy = new Date(startOfToday + (dueTomorrow ? 1 : 0) * DAY + 17 * HOUR);
    const placedAt = new Date(
      shipBy.getTime() -
        CHANNEL_RULES[channel as keyof typeof CHANNEL_RULES].shipBy.defaultDays * DAY -
        random.int(1, 10) * HOUR,
    );
    const finalState = random.pick([
      "imported",
      "ready",
      "ready",
      "ready",
      "needs_mapping",
      "needs_artwork",
      "on_sheet",
      "on_sheet",
      "transfer_in",
      "pressed",
      "packed",
    ] as const);
    plans_.push({ placedAt, shipBy, channel, finalState });
  }
  plans_.sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());

  const PATH: OrderItemState[] = [
    "ready",
    "on_sheet",
    "transfer_in",
    "pressed",
    "packed",
    "shipped",
    "delivered",
  ];
  const personalizedCodes = new Set(
    DESIGNS.filter((d) => d.template !== undefined).map((d) => d.code),
  );
  const designByCode = new Map(DESIGNS.map((d) => [d.code, d]));
  const artworkRenders: {
    key: string;
    template: (typeof TEMPLATES)[number];
    values: Record<string, string>;
  }[] = [];
  const productionItems: {
    id: string;
    orderNo: string;
    designName: string;
    size: string;
    color: string;
    state: OrderItemState;
    placedAt: Date;
    isReprint: boolean;
    blankVariantId: string;
    fileKey: string;
    widthIn: number;
    heightIn: number;
  }[] = [];
  const shippedOrders: {
    id: string;
    orderNo: string;
    channel: string;
    itemIds: string[];
    delivered: boolean;
    shipBy: Date;
    placedAt: Date;
    zip: string;
    name: string;
    city: string;
    state: string;
    weightOz: number;
  }[] = [];
  const actor = { kind: "user" as const, userId: people.office };
  const pressActor = {
    kind: "user" as const,
    userId: people.presser,
    stationId: stationIds["Press 1"] as string,
  };
  const packActor = {
    kind: "user" as const,
    userId: people.packer,
    stationId: stationIds["Pack 1"] as string,
  };
  const shopBlanksByStyle = new Map<string, typeof blanks>();
  for (const b of blanks)
    shopBlanksByStyle.set(b.styleCode, [...(shopBlanksByStyle.get(b.styleCode) ?? []), b]);
  const sizeWeights = ["S", "M", "M", "L", "L", "L", "XL", "XL", "2XL", "3XL"];

  let orderIndex = 0;
  const backdate: { orderId: string; placedAt: Date }[] = [];
  for (let batchStart = 0; batchStart < plans_.length; batchStart += 20) {
    const batch = plans_.slice(batchStart, batchStart + 20);
    await run(async (tx) => {
      for (const plan of batch) {
        const i = orderIndex++;
        const orderNo = orderNoFor(plan.channel, i);
        const first = random.pick(FIRST_NAMES);
        const last = random.pick(LAST_NAMES);
        const city = random.pick(CITIES);
        const lineCount = random.chance(0.6) ? 1 : random.chance(0.7) ? 2 : 3;
        const lines: {
          design: (typeof DESIGNS)[number];
          blank: (typeof blanks)[number];
          qty: number;
          needsMapping: boolean;
        }[] = [];
        for (let l = 0; l < lineCount; l++) {
          const design = random.pick(DESIGNS);
          const styleCode = random.chance(0.75)
            ? "G64000"
            : random.chance(0.6)
              ? "CC1717"
              : "BC3001";
          const candidates = shopBlanksByStyle.get(styleCode) ?? blanks;
          const size = random.pick(sizeWeights);
          const colorCode = random.pick(candidates.map((b) => b.colorCode));
          const blank =
            candidates.find((b) => b.sizeCode === size && b.colorCode === colorCode) ??
            (candidates[0] as (typeof blanks)[number]);
          lines.push({
            design,
            blank,
            qty: random.chance(0.8) ? 1 : 2,
            needsMapping: plan.finalState === "needs_mapping" && l === 0,
          });
        }
        const units = lines.reduce((n, l) => n + l.qty, 0);
        const unitPrice =
          plan.channel === "tiktok"
            ? 2299
            : plan.channel === "shopify"
              ? 2800
              : plan.channel === "amazon"
                ? 2699
                : 2499;
        const subtotal = lines.reduce(
          (n, l) => n + l.qty * (l.blank.styleCode === "CC1717" ? unitPrice + 800 : unitPrice),
          0,
        );
        const shipping = plan.channel === "amazon" ? 0 : random.pick([0, 0, 499, 599]);
        const hasPersonalization = lines.some((l) => personalizedCodes.has(l.design.code));
        const [order] = await tx
          .insert(orders)
          .values({
            companyId: shopId,
            connectionId: channels[plan.channel] as string,
            channel: plan.channel as "etsy",
            channelOrderId: `${plan.channel}-${orderNo.replace(/[^0-9a-z]/gi, "")}`,
            orderNo,
            placedAt: plan.placedAt,
            shipBy: plan.shipBy,
            isRush: random.chance(0.08),
            hasPersonalization,
            shippingMethod:
              plan.channel === "amazon" ? "Standard" : shipping ? "Standard" : "Free shipping",
            buyerNote: random.chance(0.1)
              ? random.pick([
                  "Gift for my sister, please no invoice",
                  "Please ship ASAP",
                  "Leave at side door",
                ])
              : null,
            buyerRef: `buyer-${(first + last).toLowerCase()}-${i % 97}`,
            subtotalCents: subtotal,
            shippingCents: shipping,
            taxCents: Math.round(subtotal * 0.072),
            discountCents: random.chance(0.15) ? 300 : 0,
            totalCents: subtotal + shipping + Math.round(subtotal * 0.072),
            itemCount: units,
            tags: random.chance(0.1) ? ["repeat-buyer"] : [],
            createdAt: plan.placedAt,
            updatedAt: plan.placedAt,
          })
          .returning();
        if (!order) throw new Error("order insert failed");
        await tx.insert(buyerPii).values({
          companyId: shopId,
          orderId: order.id,
          name: `${first} ${last}`,
          email: `${first}.${last}${i}@example.com`.toLowerCase(),
          phone: random.chance(0.5) ? `602-555-${String(1000 + i).slice(-4)}` : null,
          street1: `${random.int(100, 9800)} ${random.pick(STREETS)}`,
          street2: random.chance(0.2) ? `Apt ${random.int(1, 40)}` : null,
          city: city.city,
          state: city.state,
          zip: city.zip,
          country: "US",
        });

        const itemIds: string[] = [];
        let lineNo = 0;
        for (const line of lines) {
          lineNo++;
          const personalized = personalizedCodes.has(line.design.code);
          const answers = personalized ? random.pick(PERSONALIZATION_ANSWERS) : null;
          const slotQuestions = personalized
            ? (TEMPLATES[designByCode.get(line.design.code)?.template ?? 0]?.slots ?? [])
            : [];
          for (let unit = 1; unit <= line.qty; unit++) {
            const [item] = await tx
              .insert(orderItems)
              .values({
                companyId: shopId,
                orderId: order.id,
                lineNo,
                unitNo: unit,
                unitsInLine: line.qty,
                channelLineId: `${orderNo}-${lineNo}`,
                channelSku: line.needsMapping
                  ? `${plan.channel.toUpperCase()}-${random.int(10000, 99999)}-TEE`
                  : `${line.design.code}-${line.blank.styleCode}-${line.blank.colorCode}-${line.blank.sizeCode}`,
                channelListingId: String(
                  1400000000 + Number.parseInt(line.design.code.slice(2), 10),
                ),
                title: `${line.design.name} Shirt`,
                variantTitle: `${line.blank.color} / ${line.blank.size}`,
                unitPriceCents: line.blank.styleCode === "CC1717" ? unitPrice + 800 : unitPrice,
                personalization: answers
                  ? slotQuestions.map((s) => ({
                      question: s.sourceQuestion ?? s.name,
                      answer:
                        (answers as Record<string, string>)[s.sourceQuestion ?? s.name] ?? null,
                      fileUrl: null,
                    }))
                  : [],
                shipBy: plan.shipBy,
                isRush: order.isRush,
                designId: line.needsMapping ? null : designIds.get(line.design.code),
                productId: null,
                blankVariantId: line.needsMapping ? null : line.blank.id,
                placement: line.design.size.placement,
                printWidthIn: line.design.size.widthIn,
                printHeightIn: line.design.size.heightIn,
                artworkStatus: personalized
                  ? plan.finalState === "needs_artwork"
                    ? "flagged"
                    : "approved"
                  : "none",
                artworkKey:
                  personalized && plan.finalState !== "needs_artwork"
                    ? `${shopId}/artwork/seed/${order.id.slice(0, 8)}-${lineNo}-${unit}.png`
                    : null,
                flags: line.needsMapping
                  ? [
                      {
                        code: "needs_mapping",
                        severity: "error",
                        message: "SKU not recognized",
                        active: true,
                        createdAt: plan.placedAt.toISOString(),
                      },
                    ]
                  : [],
                createdAt: plan.placedAt,
                updatedAt: plan.placedAt,
              })
              .returning();
            if (!item) throw new Error("item insert failed");
            itemIds.push(item.id);
            if (item.artworkKey && answers) {
              const template = TEMPLATES[designByCode.get(line.design.code)?.template ?? 0];
              if (template)
                artworkRenders.push({
                  key: item.artworkKey,
                  template,
                  values: Object.fromEntries(
                    slotQuestions.map((sl) => [
                      sl.name,
                      (answers as Record<string, string>)[sl.sourceQuestion ?? sl.name] ?? "",
                    ]),
                  ),
                });
            }

            // Walk the item through the state machine to its planned state.
            let target: OrderItemState = plan.finalState;
            if (line.needsMapping) target = "needs_mapping";
            else if (plan.finalState === "needs_mapping") target = "ready";
            if (plan.finalState === "needs_artwork" && !personalized) target = "ready";
            const path: OrderItemState[] = [];
            if (target === "needs_mapping") path.push("needs_mapping");
            else if (target === "needs_artwork") path.push("ready", "needs_artwork");
            else if (target === "on_hold" || target === "cancelled") {
              const stop = random.int(0, 3);
              path.push(...PATH.slice(0, stop), target);
            } else if (target !== "imported") {
              const idx = PATH.indexOf(target);
              path.push(...PATH.slice(0, idx + 1));
            }
            let qcFailed = false;
            for (const next of path) {
              const stationKind =
                next === "pressed"
                  ? "press"
                  : next === "packed"
                    ? "pack"
                    : next === "transfer_in"
                      ? "pick"
                      : null;
              const a = next === "pressed" ? pressActor : next === "packed" ? packActor : actor;
              if (next === "packed" && plan.qcFail && !qcFailed) {
                // QC fail: pressed -> ready (reprint), then back through the sheet.
                qcFailed = true;
                await transitionItem(tx, item.id, "ready", {
                  actor: pressActor,
                  stationKind: "qc",
                  reason: "qc_fail",
                });
                await tx.insert(reprints).values({
                  companyId: shopId,
                  orderItemId: item.id,
                  reason: "peel",
                  note: "Edge lifted after press",
                  status: "done",
                  requestedBy: pressActor.userId,
                  stationId: stationIds["QC 1"] ?? null,
                  requestedAt: new Date(plan.placedAt.getTime() + 20 * HOUR),
                });
                await tx
                  .update(orderItems)
                  .set({ isReprint: true })
                  .where(eq(orderItems.id, item.id));
                await transitionItem(tx, item.id, "on_sheet", { actor });
                await transitionItem(tx, item.id, "transfer_in", { actor, stationKind: "pick" });
                await transitionItem(tx, item.id, "pressed", {
                  actor: pressActor,
                  stationKind: "press",
                });
              }
              await transitionItem(tx, item.id, next, {
                actor: a,
                stationKind,
                reason:
                  next === "on_hold"
                    ? "address_check"
                    : next === "cancelled"
                      ? "buyer_request"
                      : null,
              });
            }
            const finalItemState = path[path.length - 1] ?? "imported";
            if (
              ["on_sheet", "transfer_in", "pressed", "packed", "shipped", "delivered"].includes(
                finalItemState,
              )
            ) {
              productionItems.push({
                id: item.id,
                orderNo,
                designName: line.design.name,
                size: line.blank.size,
                color: line.blank.color,
                state: finalItemState,
                placedAt: plan.placedAt,
                isReprint: qcFailed,
                blankVariantId: line.blank.id,
                fileKey: `${shopId}/design/seed/${line.design.code.toLowerCase()}.png`,
                widthIn: line.design.size.widthIn,
                heightIn: line.design.size.heightIn,
              });
            }
          }
        }

        if (plan.hold) {
          await tx
            .update(orders)
            .set({
              holdReason: "address_check",
              holdNote: "Apartment number missing",
              heldAt: new Date(plan.placedAt.getTime() + 6 * HOUR),
            })
            .where(eq(orders.id, order.id));
        }
        if (plan.cancel) {
          await tx
            .update(orders)
            .set({
              cancelReason: "buyer_request",
              cancelNote: null,
              cancelledAt: new Date(plan.placedAt.getTime() + 10 * HOUR),
            })
            .where(eq(orders.id, order.id));
        }
        if (plan.finalState === "shipped" || plan.finalState === "delivered") {
          shippedOrders.push({
            id: order.id,
            orderNo,
            channel: plan.channel,
            itemIds,
            delivered: plan.finalState === "delivered",
            shipBy: plan.shipBy,
            placedAt: plan.placedAt,
            zip: city.zip,
            name: `${first} ${last}`,
            city: city.city,
            state: city.state,
            weightOz: lines.reduce((n, l) => n + l.qty * l.blank.weightOz, 0) + 0.5,
          });
        }

        backdate.push({ orderId: order.id, placedAt: plan.placedAt });
      }
    });
    await backdateTimelines(opts, backdate.splice(0));
    log.info("orders", { done: Math.min(batchStart + 20, plans_.length), of: plans_.length });
  }

  /* ---- personalized artwork (rendered for real so proofs and sheets have a file) ---- */
  if (imagingUp && opts.render.artwork) {
    let rendered = 0;
    for (const r of artworkRenders) {
      const out = await renderValues(
        { ...r.template, backgroundKey: null, dpi: 300 },
        r.values,
        r.key,
      );
      if (out.status !== "failed") rendered++;
    }
    log.info("personalized artwork", { rendered, total: artworkRenders.length });
  }

  /* ---- gang sheets + transfers ---- */
  const sheetComposes: {
    sheetId: string;
    widthIn: number;
    lengthIn: number;
    pngKey: string;
    previewKey: string;
    placements: Parameters<typeof imaging.compose>[0]["placements"];
  }[] = [];
  const sheetsCreated = await run(async (tx) => {
    const [vendor] = await tx
      .select()
      .from(vendorConnections)
      .where(eq(vendorConnections.companyId, shopId))
      .limit(1);
    if (!vendor) throw new Error("vendor");
    const sorted = [...productionItems].sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
    const PER_SHEET = 24;
    let physicalSheetNo = 0;
    let fellBackTo = 0;
    for (let s = 0; s < sorted.length; s += PER_SHEET) {
      const chunk = sorted.slice(s, s + PER_SHEET);
      const first = chunk[0];
      if (!first) continue;
      const day = first.placedAt.toISOString().slice(0, 10);
      const states = new Set(chunk.map((c) => c.state));
      const status = states.has("on_sheet")
        ? random.chance(0.5)
          ? "sent"
          : "printed"
        : "received";
      // Real nesting (T-13-5, B-111): the product builds gang sheets through imaging's `/nest`
      // (real 2D nesting, with rotation), and the seed's demo numbers need to reflect that same
      // algorithm rather than a bespoke seed-only packer. Imaging is required for the seed, so
      // this should always succeed; the FFD shelf pack below is a fallback for when it isn't
      // reachable, so the seed can still finish (logged as a warning, since it changes the
      // reported efficiency).
      let plans: SheetPlan<(typeof chunk)[number]>[];
      try {
        const byId = new Map(chunk.map((c) => [c.id, c]));
        const nest = await imaging.nest({
          items: chunk.map((c) => ({ id: c.id, width_in: c.widthIn, height_in: c.heightIn })),
          sheet_width_in: DEFAULT_SHEET_SPEC.widthIn,
          spacing_in: DEFAULT_SHEET_SPEC.spacingIn,
          margin_in: DEFAULT_SHEET_SPEC.marginIn,
          max_length_in: DEFAULT_SHEET_SPEC.maxLengthIn,
          allow_rotation: true,
          label_height_in: LABEL_HEIGHT_IN,
          header_height_in: HEADER_HEIGHT_IN,
        });
        plans = nest.sheets
          .map((ns) => ({
            lengthIn: Math.round(ns.length_in * 100) / 100,
            utilization: Math.round(ns.utilization * 100) / 100,
            placements: ns.placements
              .filter((p) => byId.has(p.id))
              .map((p) => ({
                item: byId.get(p.id) as (typeof chunk)[number],
                xIn: p.x_in,
                yIn: p.y_in,
                rotated: p.rotated,
              })),
          }))
          .filter((p) => p.placements.length > 0);
        const placed = plans.reduce((n, p) => n + p.placements.length, 0);
        if (!plans.length) throw new Error("nest returned no sheets");
        if (placed < chunk.length)
          log.warn("seed: /nest left items unplaced", { day, placed, of: chunk.length });
      } catch (err) {
        fellBackTo++;
        log.warn("seed: imaging /nest unreachable, falling back to FFD shelf pack", {
          day,
          error: err instanceof Error ? err.message : String(err),
        });
        plans = [ffdPack(chunk, DEFAULT_SHEET_SPEC)];
      }
      const builtAt = new Date(first.placedAt.getTime() + 8 * HOUR);
      const [batch] = await tx
        .insert(gangSheetBatches)
        .values({
          companyId: shopId,
          name: `${day} build`,
          status: status === "received" ? "complete" : "sent",
          dueBefore: new Date(first.placedAt.getTime() + 2 * DAY),
          vendorConnectionId: vendor.id,
          itemCount: chunk.length,
          sheetCount: plans.length,
          createdBy: ownerId,
          createdAt: builtAt,
          updatedAt: builtAt,
        })
        .returning();
      if (!batch) throw new Error("batch");
      for (let pi = 0; pi < plans.length; pi++) {
        const plan = plans[pi] as SheetPlan<(typeof chunk)[number]>;
        const placements = plan.placements;
        physicalSheetNo++;
        const [sheet] = await tx
          .insert(gangSheets)
          .values({
            companyId: shopId,
            batchId: batch.id,
            sheetNo: pi + 1,
            name: `${day} #${physicalSheetNo}`,
            vendorConnectionId: vendor.id,
            widthIn: DEFAULT_SHEET_SPEC.widthIn,
            lengthIn: plan.lengthIn,
            utilization: plan.utilization,
            status,
            transferCount: placements.length,
            reprintCount: placements.filter((p) => p.item.isReprint).length,
            costCents: Math.round(plan.lengthIn * DEFAULT_SHEET_SPEC.pricePerInch),
            // Open sheets get real files (composed below); historical ones keep no file.
            pngKey:
              status === "received" ? null : `${shopId}/sheet/seed/${day}-${physicalSheetNo}.png`,
            previewKey:
              status === "received" ? null : `${shopId}/preview/seed/${day}-${physicalSheetNo}.png`,
            sentAt: new Date(builtAt.getTime() + HOUR),
            acknowledgedAt: status === "sent" ? null : new Date(builtAt.getTime() + 3 * HOUR),
            printedAt: status === "sent" ? null : new Date(builtAt.getTime() + 20 * HOUR),
            shippedAt: status === "received" ? new Date(builtAt.getTime() + 26 * HOUR) : null,
            receivedAt: status === "received" ? new Date(builtAt.getTime() + 44 * HOUR) : null,
            trackingCarrier: status === "received" ? "ups" : null,
            trackingCode:
              status === "received" ? `1Z999AA1${String(10000000 + physicalSheetNo * 4321)}` : null,
            createdAt: builtAt,
            updatedAt: builtAt,
          })
          .returning();
        if (!sheet) throw new Error("sheet");
        if (sheet.pngKey && sheet.previewKey)
          sheetComposes.push({
            sheetId: sheet.id,
            widthIn: DEFAULT_SHEET_SPEC.widthIn,
            lengthIn: plan.lengthIn,
            pngKey: sheet.pngKey,
            previewKey: sheet.previewKey,
            placements: placements.map((p, k) => ({
              transfer_id: "",
              file_key: p.item.fileKey,
              x_in: p.xIn,
              y_in: p.yIn,
              width_in: p.rotated ? p.item.heightIn : p.item.widthIn,
              height_in: p.rotated ? p.item.widthIn : p.item.heightIn,
              rotated: p.rotated,
              label: {
                order_no: p.item.orderNo,
                item_no: `${k + 1}`,
                size: p.item.size,
                color: p.item.color,
                design: p.item.designName,
                reprint: p.item.isReprint,
              },
            })),
          });
        if (vendor.vendorCompanyId)
          await tx.insert(vendorAccess).values({
            companyId: shopId,
            vendorCompanyId: vendor.vendorCompanyId,
            gangSheetId: sheet.id,
            grantedBy: ownerId,
            grantedAt: sheet.sentAt ?? builtAt,
          });
        for (let k = 0; k < placements.length; k++) {
          const p = placements[k] as (typeof placements)[number];
          const item = p.item;
          const [transfer] = await tx
            .insert(transfers)
            .values({
              companyId: shopId,
              gangSheetId: sheet.id,
              orderItemId: item.id,
              xIn: p.xIn,
              yIn: p.yIn,
              widthIn: p.rotated ? item.heightIn : item.widthIn,
              heightIn: p.rotated ? item.widthIn : item.heightIn,
              rotated: p.rotated,
              label: {
                order_no: item.orderNo,
                item_no: `${k + 1}`,
                size: item.size,
                color: item.color,
                design: item.designName,
                reprint: item.isReprint,
              },
              status:
                item.state === "on_sheet"
                  ? "placed"
                  : item.state === "transfer_in"
                    ? "received"
                    : "pressed",
              isReprint: item.isReprint,
              pressedAt: ["pressed", "packed", "shipped", "delivered"].includes(item.state)
                ? new Date(builtAt.getTime() + 50 * HOUR)
                : null,
              createdAt: builtAt,
              updatedAt: builtAt,
            })
            .returning({ id: transfers.id });
          if (!transfer) throw new Error("transfer");
          const compose = sheetComposes.find((c) => c.sheetId === sheet.id);
          const placement = compose?.placements[k];
          if (placement) placement.transfer_id = transfer.id;
          await tx
            .update(orderItems)
            .set({ transferId: transfer.id, gangSheetId: sheet.id })
            .where(eq(orderItems.id, item.id));
          if (
            ["pressed", "packed", "shipped", "delivered"].includes(item.state) &&
            item.placedAt.getTime() > now - 4 * DAY
          ) {
            await tx.insert(scans).values({
              companyId: shopId,
              clientScanId: crypto.randomUUID(),
              stationId: stationIds["Press 1"] ?? null,
              station: "press",
              action: "press",
              userId: pressActor.userId,
              transferCode: `T:${transfer.id}`,
              blankCode: `B:${item.blankVariantId}`,
              transferId: transfer.id,
              orderItemId: item.id,
              ok: true,
              mismatch: null,
              result: { ok: true, message: "Match" },
              scannedAt: new Date(builtAt.getTime() + 50 * HOUR),
            });
          }
        }
      }
    }
    if (fellBackTo > 0)
      log.warn("seed: sheets built with the FFD fallback", { chunks: fellBackTo });
    return physicalSheetNo;
  });
  // Real PNG + preview for the sheets a vendor can still open (the historical ones have none).
  let composed = 0;
  for (const c of sheetComposes) {
    if (!imagingUp || !opts.render.sheets) break;
    try {
      await imaging.compose({
        width_in: c.widthIn,
        length_in: c.lengthIn,
        placements: c.placements,
        out_key: c.pngKey,
        preview_key: c.previewKey,
        preview_width_px: 1200,
      });
      composed++;
    } catch (err) {
      log.warn("sheet compose failed", { sheet: c.sheetId, error: String(err) });
      await run((tx) =>
        tx
          .update(gangSheets)
          .set({ pngKey: null, previewKey: null })
          .where(eq(gangSheets.id, c.sheetId)),
      );
    }
  }
  log.info("sheet files", { composed, of: sheetComposes.length });
  log.info("sheets", { count: sheetsCreated, transfers: productionItems.length });

  /* ---- shipments ---- */
  await run(async (tx) => {
    let n = 0;
    for (const o of shippedOrders) {
      n++;
      const labeledAt = new Date(
        Math.min(o.shipBy.getTime() - 3 * HOUR, o.placedAt.getTime() + 40 * HOUR),
      );
      const postage = 450 + Math.round(o.weightOz * 22);
      const tracking = `9400 1000 0000 ${String(1000 + n).padStart(4, "0")} ${String(3000 + n * 7).padStart(4, "0")} ${String(10 + (n % 90)).padStart(2, "0")}`;
      const [shipment] = await tx
        .insert(shipments)
        .values({
          companyId: shopId,
          orderId: o.id,
          orderItemIds: o.itemIds,
          status: o.delivered ? "delivered" : "in_transit",
          carrier: "usps",
          service: "GroundAdvantage",
          trackingCode: tracking,
          trackingUrl: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tracking.replace(/\s/g, "")}`,
          trackingStatus: o.delivered ? "delivered" : "in_transit",
          labelKey: `${shopId}/label/seed/${o.orderNo.replace(/[^0-9a-z]/gi, "")}.pdf`,
          labelFormat: "pdf",
          postageCents: postage,
          labelFeeCents: 4,
          lengthIn: 10,
          widthIn: 13,
          heightIn: 1,
          weightOz: Math.round(o.weightOz * 10) / 10,
          ratedAt: labeledAt,
          carrierShipmentId: `shp_mock_${n}`,
          trackingPushStatus: o.channel === "shopify" || random.chance(0.9) ? "pushed" : "failed",
          trackingPushedAt: labeledAt,
          trackingPushAttempts: 1,
          labeledAt,
          deliveredAt: o.delivered ? new Date(labeledAt.getTime() + 3 * DAY) : null,
          createdAt: labeledAt,
          updatedAt: labeledAt,
        })
        .returning({ id: shipments.id });
      if (!shipment) throw new Error("shipment");
      await tx
        .update(orderItems)
        .set({ shipmentId: shipment.id })
        .where(inArray(orderItems.id, o.itemIds));
      await tx
        .update(orders)
        .set({
          shippedAt: labeledAt,
          deliveredAt: o.delivered ? new Date(labeledAt.getTime() + 3 * DAY) : null,
        })
        .where(eq(orders.id, o.id));
      if (o.delivered) {
        await tx
          .update(buyerPii)
          .set({ purgeAfter: new Date(labeledAt.getTime() + 33 * DAY) })
          .where(eq(buyerPii.orderId, o.id));
      }
    }
    log.info("shipments", { count: n });
  });

  /* ---- inventory ledger + stock cache ---- */
  await run(async (tx) => {
    const receiverId = people.receiver;
    const receivedAt = new Date(now - 12 * DAY);
    const lowStock = new Set(blanks.filter((_, i) => i % 13 === 0).map((b) => b.id));
    const consumed = await tx
      .select({
        id: orderItems.id,
        blankVariantId: orderItems.blankVariantId,
        state: orderItems.state,
        at: orderItems.stateChangedAt,
      })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.companyId, shopId),
          inArray(orderItems.state, [
            "pressed",
            "packed",
            "shipped",
            "delivered",
            "ready",
            "on_sheet",
            "transfer_in",
          ]),
        ),
      );
    // Opening stock covers everything already pressed or reserved, so no blank goes negative;
    // "low" blanks end up just under their reorder point.
    const committed = new Map<string, number>();
    for (const it of consumed)
      if (it.blankVariantId)
        committed.set(it.blankVariantId, (committed.get(it.blankVariantId) ?? 0) + 1);
    for (const b of blanks) {
      const base =
        b.styleCode === "G64000"
          ? random.int(14, 48)
          : b.styleCode === "CC1717"
            ? random.int(8, 24)
            : random.int(10, 30);
      const used = committed.get(b.id) ?? 0;
      const qty =
        used + (lowStock.has(b.id) ? random.int(2, 6) : Math.max(base, random.int(6, 12)));
      await tx.insert(inventoryMovements).values({
        companyId: shopId,
        blankVariantId: b.id,
        locationId,
        kind: "receive",
        qty,
        unitCostCents: b.costCents,
        refType: "purchase_order",
        refId: null,
        note: "Opening stock",
        userId: receiverId,
        idempotencyKey: `seed:receive:${b.id}`,
        createdAt: receivedAt,
      });
    }
    for (const it of consumed) {
      if (!it.blankVariantId) continue;
      const isConsume = ["pressed", "packed", "shipped", "delivered"].includes(it.state);
      await tx.insert(inventoryMovements).values({
        companyId: shopId,
        blankVariantId: it.blankVariantId,
        locationId,
        kind: isConsume ? "consume" : "reserve",
        qty: isConsume ? -1 : 1,
        refType: "order_item",
        refId: it.id,
        userId: null,
        idempotencyKey: `seed:${isConsume ? "consume" : "reserve"}:${it.id}`,
        createdAt: it.at,
      });
    }
    await tx.execute(sql`
      insert into stock_levels (company_id, blank_variant_id, location_id, on_hand, reserved, available, updated_at)
      select company_id, blank_variant_id, location_id,
        sum(case when kind in ('receive','consume','adjust','return','scrap','count','transfer') then qty else 0 end) as on_hand,
        sum(case when kind = 'reserve' then qty when kind = 'release' then -qty else 0 end) as reserved,
        sum(case when kind in ('receive','consume','adjust','return','scrap','count','transfer') then qty else 0 end)
          - sum(case when kind = 'reserve' then qty when kind = 'release' then -qty else 0 end) as available,
        now()
      from inventory_movements where company_id = ${shopId}
      group by company_id, blank_variant_id, location_id
      on conflict (company_id, blank_variant_id, location_id) do update set
        on_hand = excluded.on_hand, reserved = excluded.reserved,
        available = excluded.available, updated_at = excluded.updated_at`);
    // Shelf labels for the pick queue: one bay per style, one shelf per color, one bin per size.
    const colorsByStyle = new Map<string, string[]>();
    for (const b of blanks) {
      const list = colorsByStyle.get(b.styleCode) ?? [];
      if (!list.includes(b.colorCode)) list.push(b.colorCode);
      colorsByStyle.set(b.styleCode, list);
    }
    for (const b of blanks) {
      await tx
        .update(stockLevels)
        .set({ shelf: shelfFor(b, undefined, colorsByStyle.get(b.styleCode)) })
        .where(and(eq(stockLevels.companyId, shopId), eq(stockLevels.blankVariantId, b.id)));
    }
    const low = await tx
      .select({
        variantId: stockLevels.blankVariantId,
        available: stockLevels.available,
        sku: blankVariants.sku,
      })
      .from(stockLevels)
      .innerJoin(blankVariants, eq(blankVariants.id, stockLevels.blankVariantId))
      .where(
        and(
          eq(stockLevels.companyId, shopId),
          sql`${stockLevels.available} < ${blankVariants.reorderPoint}`,
        ),
      );
    if (low.length) {
      await tx.insert(alerts).values(
        low.map((l) => ({
          companyId: shopId,
          kind: "stock_low",
          severity: l.available <= 0 ? ("critical" as const) : ("warning" as const),
          title: `Low stock: ${l.sku}`,
          message: `${l.available} available, reorder point 8`,
          entityType: "blank_variant",
          entityId: l.variantId,
          dedupeKey: `stock_low:${l.variantId}`,
          data: { available: l.available, reorderPoint: 8 },
        })),
      );
    }
    log.info("inventory", {
      variants: blanks.length,
      movements: blanks.length + consumed.length,
      lowStock: low.length,
    });
  });

  /* ---- channel listings (from the seeded orders; push stays off until the shop opts in) ---- */
  const listingReport = await run((tx) => recordListingsForCompany(tx, shopId));
  log.info("listings", { listings: listingReport.listings, variants: listingReport.variants });

  /* ---- ad spend, usage, at-risk alerts ---- */
  await run(async (tx) => {
    const spend: (typeof adSpend.$inferInsert)[] = [];
    for (let d = 0; d < opts.volume.adSpendDays; d++) {
      const day = new Date(now - d * DAY).toISOString().slice(0, 10);
      spend.push({
        companyId: shopId,
        day,
        channel: "etsy",
        amountCents: random.int(1200, 4500),
        campaign: "Etsy Ads",
        note: null,
      });
      spend.push({
        companyId: shopId,
        day,
        channel: "shopify",
        amountCents: random.int(2000, 6000),
        campaign: profile.adCampaign,
        note: null,
      });
      if (d % 2 === 0)
        spend.push({
          companyId: shopId,
          day,
          channel: "tiktok",
          amountCents: random.int(800, 2500),
          campaign: "TikTok Spark",
          note: null,
        });
    }
    await tx.insert(adSpend).values(spend);
    const period = new Date().toISOString().slice(0, 7);
    const [ordersThisPeriod] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(orders)
      .where(and(eq(orders.companyId, shopId), sql`to_char(placed_at, 'YYYY-MM') = ${period}`));
    const [labelsThisPeriod] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(shipments)
      .where(and(eq(shipments.companyId, shopId), sql`to_char(labeled_at, 'YYYY-MM') = ${period}`));
    await tx.insert(usage).values({
      companyId: shopId,
      period,
      ordersImported: ordersThisPeriod?.n ?? 0,
      labelsBought: labelsThisPeriod?.n ?? 0,
      labelFeesCents: (labelsThisPeriod?.n ?? 0) * 4,
      sheetsBuilt: sheetsCreated,
      aiCredits: 37,
    });
    const atRisk = await tx
      .select({ id: orders.id, orderNo: orders.orderNo })
      .from(orders)
      .where(
        and(
          eq(orders.companyId, shopId),
          inArray(orders.status, ["new", "needs_attention", "in_production"]),
          sql`${orders.shipBy} < now() + interval '24 hours'`,
        ),
      )
      .limit(6);
    if (atRisk.length) {
      await tx.insert(alerts).values(
        atRisk.map((o) => ({
          companyId: shopId,
          kind: "order_at_risk",
          severity: "warning" as const,
          title: `Order ${o.orderNo} at risk`,
          message: "Ships within 24 hours and is not packed yet",
          entityType: "order",
          entityId: o.id,
          dedupeKey: `order_at_risk:${o.id}`,
        })),
      );
    }
  });

  const released = await opts.run((tx) => releaseOutbox(tx, shopId));
  log.info("outbox released", { events: released });

  return { locationId, stationToken, channels, sheets: sheetsCreated };
}

/**
 * Spread each order's transitions over the hours after it was placed, and set the items'
 * `state_changed_at` to match. Scoped to the orders just built and to this company.
 */
async function backdateTimelines(
  opts: ShopSeedOptions,
  batch: { orderId: string; placedAt: Date }[],
) {
  if (!opts.runHistory || !batch.length) return;
  const companyId = opts.companyId;
  await opts.runHistory(async (tx) => {
    for (const { orderId, placedAt } of batch) {
      await tx.execute(sql`
        with numbered as (
          select id, row_number() over (partition by order_item_id order by created_at, id) as n
          from order_item_transitions where order_id = ${orderId} and company_id = ${companyId}
        )
        update order_item_transitions t
        set created_at = ${placedAt}::timestamptz + (numbered.n * interval '5 hours')
        from numbered where numbered.id = t.id`);
      await tx.execute(sql`
        update order_items set state_changed_at = coalesce((select max(created_at) from order_item_transitions where order_item_id = order_items.id), ${placedAt}::timestamptz)
        where order_id = ${orderId} and company_id = ${companyId}`);
    }
  });
}
