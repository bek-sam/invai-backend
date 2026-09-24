import { writeFileSync } from "node:fs";
import { CHANNEL_RULES, type OrderItemState } from "@invai/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { systemContext } from "../../api/context";
import { auth } from "../../auth";
import { imaging } from "../../integrations/imaging/client";
import { logger } from "../../lib/log";
import { bulkImportBlanks, createDesign, createProduct } from "../../modules/catalog/service";
import { transitionItem } from "../../modules/orders/state-machine";
import { issueStationToken, setPin } from "../../modules/tenancy/floor-auth";
import { closeDb, systemDb, withSystem } from "../client";
import type { Role } from "../schema";
import {
  adSpend,
  alerts,
  blankVariants,
  buyerPii,
  channelConnections,
  companies,
  costSettings,
  DEFAULT_SHEET_SPEC,
  designFiles,
  gangSheetBatches,
  gangSheets,
  inventoryMovements,
  inventorySettings,
  locations,
  members,
  orderItems,
  orders,
  packagePresets,
  personalizationTemplates,
  plans,
  reprints,
  scans,
  shipments,
  shippingSettings,
  skuRules,
  stations,
  stockLevels,
  subscriptions,
  suppliers,
  trademarkMarks,
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
  rng,
  SIZES,
  STREETS,
  TEMPLATES,
} from "./data";
import { normalizeMark, TRADEMARK_MARKS } from "./trademarks";

/*
 * Demo seed: "Desert Bloom Tees" (v1-plan 5.4). Runs as the owner role. Idempotent-ish: it
 * refuses to run twice (reset the database first). Orders go through the real state machine
 * so transitions, audit rows and outbox events are consistent with production behaviour.
 *
 *   pnpm db:reset && pnpm db:migrate && pnpm db:seed
 */

const log = logger("seed");
const PASSWORD = "demo1234!";
const random = rng(20260924);
const DAY = 86_400_000;
const HOUR = 3_600_000;

type SeedUser = { email: string; name: string; role: Role; pin: string };

const SHOP_USERS: SeedUser[] = [
  { email: "owner@desertbloom.test", name: "Riley Owner", role: "owner", pin: "1111" },
  { email: "admin@desertbloom.test", name: "Alex Admin", role: "admin", pin: "1122" },
  { email: "office@desertbloom.test", name: "Olivia Office", role: "office", pin: "1133" },
  { email: "designer@desertbloom.test", name: "Dana Designer", role: "designer", pin: "1144" },
  { email: "presser@desertbloom.test", name: "Pat Presser", role: "presser", pin: "1155" },
  { email: "packer@desertbloom.test", name: "Paula Packer", role: "packer", pin: "1166" },
  { email: "receiver@desertbloom.test", name: "Ray Receiver", role: "receiver", pin: "1177" },
  { email: "luis@desertbloom.test", name: "Luis Presser", role: "presser", pin: "1188" },
];

async function signUp(email: string, name: string): Promise<string> {
  const res = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
  await systemDb.update(users).set({ emailVerified: true }).where(eq(users.id, res.user.id));
  return res.user.id;
}

async function seedGlobals() {
  await systemDb
    .insert(plans)
    .values([
      {
        key: "trial",
        name: "Trial",
        priceMonthlyCents: 0,
        ordersPerMonth: 200,
        aiCreditsPerMonth: 50,
        labelFeeCents: 0,
        maxUsers: 3,
        maxConnections: 2,
      },
      {
        key: "starter",
        name: "Starter",
        priceMonthlyCents: 4900,
        ordersPerMonth: 1000,
        aiCreditsPerMonth: 200,
        labelFeeCents: 5,
        maxUsers: 5,
        maxConnections: 3,
      },
      {
        key: "growth",
        name: "Growth",
        priceMonthlyCents: 14900,
        ordersPerMonth: 5000,
        aiCreditsPerMonth: 1000,
        labelFeeCents: 4,
        maxUsers: 15,
        maxConnections: 6,
      },
      {
        key: "pro",
        name: "Pro",
        priceMonthlyCents: 34900,
        ordersPerMonth: 20000,
        aiCreditsPerMonth: 4000,
        labelFeeCents: 3,
        maxUsers: 40,
        maxConnections: 12,
      },
      {
        key: "scale",
        name: "Scale",
        priceMonthlyCents: 79900,
        ordersPerMonth: null,
        aiCreditsPerMonth: 15000,
        labelFeeCents: 2,
        maxUsers: null,
        maxConnections: null,
      },
    ])
    .onConflictDoNothing();
  await systemDb
    .insert(trademarkMarks)
    .values(
      TRADEMARK_MARKS.map((m) => ({
        mark: m.mark,
        normalized: normalizeMark(m.mark),
        owner: m.owner,
        kind: m.kind,
        status: "live" as const,
        classes: [25],
        serialNo: null,
        source: "seed",
      })),
    )
    .onConflictDoNothing();
  log.info("globals", { plans: 5, trademarks: TRADEMARK_MARKS.length });
}

async function main() {
  const started = Date.now();
  const [existing] = await systemDb
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.slug, "desert-bloom-tees"))
    .limit(1);
  if (existing) {
    log.warn("Desert Bloom Tees already exists; run `pnpm db:reset && pnpm db:migrate` first");
    return;
  }
  await seedGlobals();

  /* ---- companies and users ---- */
  const [shop] = await systemDb
    .insert(companies)
    .values({
      name: "Desert Bloom Tees",
      slug: "desert-bloom-tees",
      type: "shop",
      plan: "growth",
      timezone: "America/Phoenix",
      demo: true,
    })
    .returning();
  const [vendorOrg] = await systemDb
    .insert(companies)
    .values({
      name: "Sun City DTF",
      slug: "sun-city-dtf",
      type: "vendor",
      plan: null,
      timezone: "America/Phoenix",
      demo: true,
    })
    .returning();
  if (!shop || !vendorOrg) throw new Error("company insert failed");
  const shopId = shop.id;
  const ctx = systemContext(shopId);

  const userIds = new Map<string, string>();
  for (const u of SHOP_USERS) {
    const id = await signUp(u.email, u.name);
    userIds.set(u.email, id);
    await systemDb
      .insert(members)
      .values({ organizationId: shopId, userId: id, role: u.role, status: "active" });
  }
  const vendorUserId = await signUp("vendor@suncitydtf.test", "Val Vendor");
  await systemDb.insert(members).values({
    organizationId: vendorOrg.id,
    userId: vendorUserId,
    role: "vendor",
    status: "active",
  });
  const ownerId = userIds.get("owner@desertbloom.test") as string;
  log.info("users", { shop: SHOP_USERS.length, vendor: 1 });

  await systemDb.insert(subscriptions).values({
    companyId: shopId,
    planKey: "growth",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 20 * DAY),
  });

  /* ---- locations, stations, PINs, station token ---- */
  const { locationId, stationToken, stationIds } = await withSystem(async (tx) => {
    const [main] = await tx
      .insert(locations)
      .values({
        companyId: shopId,
        name: "Main Shop",
        isDefault: true,
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
    for (const u of SHOP_USERS) {
      await setPin(tx, {
        companyId: shopId,
        userId: userIds.get(u.email) as string,
        pin: u.pin,
        actorUserId: ownerId,
      });
    }
    const press1 = stationRows.find((s) => s.name === "Press 1");
    if (!press1) throw new Error("station");
    const { token } = await issueStationToken(tx, {
      companyId: shopId,
      stationId: press1.id,
      userId: ownerId,
    });
    return {
      locationId: main.id,
      stationToken: token,
      stationIds: Object.fromEntries(stationRows.map((s) => [s.name, s.id])),
    };
  }, shopId);

  /* ---- settings, suppliers, vendor, channels ---- */
  const channels = await withSystem(async (tx) => {
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
      fromAddress: {
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
      vendorCompanyId: vendorOrg.id,
      name: "Sun City DTF",
      email: "vendor@suncitydtf.test",
      status: "active",
      delivery: "portal",
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
          name: "Desert Bloom Tees",
          status: "connected",
          mode: "api",
          provider: "mock",
          externalShopId: "desert-bloom-tees.myshopify.com",
          connectedAt: new Date(Date.now() - 25 * DAY),
          lastPollAt: new Date(Date.now() - 4 * 60_000),
          lastWebhookAt: new Date(Date.now() - 40 * 60_000),
        },
        {
          companyId: shopId,
          channel: "etsy",
          name: "DesertBloomTees",
          status: "csv_only",
          mode: "csv",
          provider: "mock",
          externalShopId: "DesertBloomTees",
          lastImportAt: new Date(Date.now() - 3 * HOUR),
        },
        {
          companyId: shopId,
          channel: "amazon",
          name: "Desert Bloom Tees (US)",
          status: "csv_only",
          mode: "csv",
          provider: "mock",
          externalShopId: "A2DESERTBLOOM",
          lastImportAt: new Date(Date.now() - 5 * HOUR),
        },
        {
          companyId: shopId,
          channel: "tiktok",
          name: "desertbloomtees",
          status: "csv_only",
          mode: "csv",
          provider: "mock",
          externalShopId: "7495012",
          lastImportAt: new Date(Date.now() - 6 * HOUR),
        },
      ])
      .returning();
    return Object.fromEntries(rows.map((r) => [r.channel, r.id])) as Record<string, string>;
  }, shopId);

  /* ---- blanks ---- */
  const blankReport = await withSystem(
    (tx) =>
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
    shopId,
  );
  const blanks = await systemDb
    .select()
    .from(blankVariants)
    .where(eq(blankVariants.companyId, shopId));
  await systemDb
    .update(blankVariants)
    .set({ reorderPoint: 8, reorderQty: 24 })
    .where(eq(blankVariants.companyId, shopId));
  log.info("blanks", blankReport);

  /* ---- personalization templates + designs (sample art via imaging) ---- */
  const templateIds = await withSystem(async (tx) => {
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
  }, shopId);

  const imagingUp = await imaging.isUp();
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
          width_in: 11,
          height_in: 12,
          color_hex: d.color,
        });
        rendered = true;
      } catch (err) {
        log.warn("sample art failed", { design: d.code, error: String(err) });
      }
    }
    const created = await withSystem(async (tx) => {
      const design = await createDesign(tx, ctx, {
        code: d.code,
        name: d.name,
        tags: d.tags,
        placements: [{ placement: "front", fileKey, widthIn: 11, heightIn: 12 }],
        personalizationTemplateId:
          d.template === undefined ? null : (templateIds[d.template] ?? null),
      });
      if (rendered) {
        await tx
          .update(designFiles)
          .set({
            qaStatus: "passed",
            widthPx: 3300,
            heightPx: 3600,
            effectiveDpi: 300,
            qaCheckedAt: new Date(),
          })
          .where(eq(designFiles.designId, design.id));
      }
      return design;
    }, shopId);
    designIds.set(d.code, created.id);
  }
  log.info("designs", { count: DESIGNS.length, sampleArt: imagingUp });

  /* ---- products + SKU rules ---- */
  await withSystem(async (tx) => {
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
  }, shopId);

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
  for (let i = 0; i < 300; i++) {
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
  // 60 open orders due today or tomorrow.
  for (let i = 0; i < 60; i++) {
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
  const actor = { kind: "user" as const, userId: userIds.get("office@desertbloom.test") as string };
  const pressActor = {
    kind: "user" as const,
    userId: userIds.get("presser@desertbloom.test") as string,
    stationId: stationIds["Press 1"] as string,
  };
  const packActor = {
    kind: "user" as const,
    userId: userIds.get("packer@desertbloom.test") as string,
    stationId: stationIds["Pack 1"] as string,
  };
  const shopBlanksByStyle = new Map<string, typeof blanks>();
  for (const b of blanks)
    shopBlanksByStyle.set(b.styleCode, [...(shopBlanksByStyle.get(b.styleCode) ?? []), b]);
  const sizeWeights = ["S", "M", "M", "L", "L", "L", "XL", "XL", "2XL", "3XL"];

  let orderIndex = 0;
  for (let batchStart = 0; batchStart < plans_.length; batchStart += 20) {
    const batch = plans_.slice(batchStart, batchStart + 20);
    await withSystem(async (tx) => {
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
                placement: "front",
                printWidthIn: 11,
                printHeightIn: 12,
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

        // Backdate the transition timeline so it reads naturally.
        await tx.execute(sql`
          with numbered as (
            select id, row_number() over (partition by order_item_id order by created_at, id) as n
            from order_item_transitions where order_id = ${order.id}
          )
          update order_item_transitions t
          set created_at = ${plan.placedAt}::timestamptz + (numbered.n * interval '5 hours')
          from numbered where numbered.id = t.id`);
        await tx.execute(sql`
          update order_items set state_changed_at = coalesce((select max(created_at) from order_item_transitions where order_item_id = order_items.id), ${plan.placedAt}::timestamptz)
          where order_id = ${order.id}`);
      }
    }, shopId);
    log.info("orders", { done: Math.min(batchStart + 20, plans_.length), of: plans_.length });
  }

  /* ---- gang sheets + transfers ---- */
  const sheetsCreated = await withSystem(async (tx) => {
    const [vendor] = await tx
      .select()
      .from(vendorConnections)
      .where(eq(vendorConnections.companyId, shopId))
      .limit(1);
    if (!vendor) throw new Error("vendor");
    const sorted = [...productionItems].sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
    const PER_SHEET = 24;
    let sheetNo = 0;
    for (let s = 0; s < sorted.length; s += PER_SHEET) {
      const chunk = sorted.slice(s, s + PER_SHEET);
      const first = chunk[0];
      if (!first) continue;
      sheetNo++;
      const day = first.placedAt.toISOString().slice(0, 10);
      const states = new Set(chunk.map((c) => c.state));
      const status = states.has("on_sheet")
        ? random.chance(0.5)
          ? "sent"
          : "printed"
        : "received";
      const rows = Math.ceil(chunk.length / 2);
      const lengthIn = Math.round(rows * 12.35 * 100) / 100;
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
          sheetCount: 1,
          createdBy: ownerId,
          createdAt: builtAt,
          updatedAt: builtAt,
        })
        .returning();
      if (!batch) throw new Error("batch");
      const [sheet] = await tx
        .insert(gangSheets)
        .values({
          companyId: shopId,
          batchId: batch.id,
          sheetNo: 1,
          name: `${day} #${sheetNo}`,
          vendorConnectionId: vendor.id,
          widthIn: 22,
          lengthIn,
          utilization: Math.round(((chunk.length * 11 * 12) / (22 * lengthIn)) * 100) / 100,
          status,
          transferCount: chunk.length,
          reprintCount: chunk.filter((c) => c.isReprint).length,
          costCents: Math.round(lengthIn * DEFAULT_SHEET_SPEC.pricePerInch),
          pngKey: `${shopId}/sheet/seed/${day}-${sheetNo}.png`,
          previewKey: `${shopId}/preview/seed/${day}-${sheetNo}.png`,
          sentAt: new Date(builtAt.getTime() + HOUR),
          acknowledgedAt: status === "sent" ? null : new Date(builtAt.getTime() + 3 * HOUR),
          printedAt: status === "sent" ? null : new Date(builtAt.getTime() + 20 * HOUR),
          shippedAt: status === "received" ? new Date(builtAt.getTime() + 26 * HOUR) : null,
          receivedAt: status === "received" ? new Date(builtAt.getTime() + 44 * HOUR) : null,
          trackingCarrier: status === "received" ? "ups" : null,
          trackingCode:
            status === "received" ? `1Z999AA1${String(10000000 + sheetNo * 4321)}` : null,
          createdAt: builtAt,
          updatedAt: builtAt,
        })
        .returning();
      if (!sheet) throw new Error("sheet");
      await tx.insert(vendorAccess).values({
        companyId: shopId,
        vendorCompanyId: vendorOrg.id,
        gangSheetId: sheet.id,
        grantedBy: ownerId,
        grantedAt: sheet.sentAt ?? builtAt,
      });
      for (let k = 0; k < chunk.length; k++) {
        const item = chunk[k] as (typeof chunk)[number];
        const [transfer] = await tx
          .insert(transfers)
          .values({
            companyId: shopId,
            gangSheetId: sheet.id,
            orderItemId: item.id,
            xIn: k % 2 === 0 ? 0.25 : 11.25,
            yIn: Math.round(Math.floor(k / 2) * 12.35 * 100) / 100,
            widthIn: 11,
            heightIn: 12,
            rotated: false,
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
    return sheetNo;
  }, shopId);
  log.info("sheets", { count: sheetsCreated, transfers: productionItems.length });

  /* ---- shipments ---- */
  await withSystem(async (tx) => {
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
  }, shopId);

  /* ---- inventory ledger + stock cache ---- */
  await withSystem(async (tx) => {
    const receiverId = userIds.get("receiver@desertbloom.test") as string;
    const receivedAt = new Date(now - 12 * DAY);
    const lowStock = new Set(blanks.filter((_, i) => i % 13 === 0).map((b) => b.id));
    for (const b of blanks) {
      const base =
        b.styleCode === "G64000"
          ? random.int(14, 48)
          : b.styleCode === "CC1717"
            ? random.int(8, 24)
            : random.int(10, 30);
      const qty = lowStock.has(b.id) ? random.int(2, 6) : base;
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
      group by company_id, blank_variant_id, location_id`);
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
  }, shopId);

  /* ---- ad spend, usage, at-risk alerts ---- */
  await withSystem(async (tx) => {
    const spend: (typeof adSpend.$inferInsert)[] = [];
    for (let d = 0; d < 30; d++) {
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
        campaign: "Meta – Desert Bloom",
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
  }, shopId);

  const [counts] = await systemDb
    .select({
      orders: sql<number>`(select count(*) from orders where company_id = ${shopId})`.mapWith(
        Number,
      ),
      items: sql<number>`(select count(*) from order_items where company_id = ${shopId})`.mapWith(
        Number,
      ),
      transitions:
        sql<number>`(select count(*) from order_item_transitions where company_id = ${shopId})`.mapWith(
          Number,
        ),
      dueSoon:
        sql<number>`(select count(*) from orders where company_id = ${shopId} and status in ('new','needs_attention','in_production','ready_to_ship') and ship_by < now() + interval '2 days')`.mapWith(
          Number,
        ),
    })
    .from(sql`(select 1) as one`);

  const output = {
    shopId,
    vendorOrgId: vendorOrg.id,
    logins: {
      owner: "owner@desertbloom.test",
      vendor: "vendor@suncitydtf.test",
      password: PASSWORD,
    },
    pins: Object.fromEntries(SHOP_USERS.map((u) => [u.email, u.pin])),
    stationToken: { station: "Press 1", token: stationToken },
    channels,
    counts,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  writeFileSync("seed-output.json", `${JSON.stringify(output, null, 2)}\n`);
  log.info("done", { ...counts, seconds: output.seconds });
  console.log(
    `\nLogins: owner@desertbloom.test / ${PASSWORD} (all shop roles use the same password)\n        vendor@suncitydtf.test / ${PASSWORD}\nPINs:   ${SHOP_USERS.map((u) => `${u.role}=${u.pin}`).join(" ")}\nPress 1 station token (also in seed-output.json):\n        ${stationToken}\n`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeQueues } = await import("../../lib/queues");
    await closeQueues().catch(() => {});
    await closeDb();
  });
