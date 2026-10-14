import type { Role } from "../../schema";

/*
 * Profile definitions for the scale seed (spec seed-scale-profiles.md, T-54-3). Proposed
 * numbers, not measured shops: orders/day, history days, staff and stations follow the spec
 * table. Items per order are weights for 1, 2, 3, ... items (means: small 1.4, mid and large
 * 1.6). The fixed company slug is what the replay check keys on (A3.5).
 */
export const SCALE_PROFILE_NAMES = ["small", "mid", "large"] as const;
export type ScaleProfileName = (typeof SCALE_PROFILE_NAMES)[number];

export type ScaleProfile = {
  name: ScaleProfileName;
  slug: string;
  companyName: string;
  ordersPerDay: number;
  historyDays: number;
  /** Probability weights for an order with 1, 2, 3, ... items. */
  itemsMix: readonly number[];
  meanItems: number;
  designs: number;
  skus: number;
  /** Staff users per role, summing to the profile's staff count. */
  roles: Record<Role, number>;
  stations: { pick: number; press: number; qc: number; pack: number };
  vendors: number;
  /** Open, not-shipped, not-cancelled orders past ship_by (fraction of old enough orders). */
  stuckPct: number;
  /** Aimed number of transfers on one gang sheet. */
  perSheet: number;
  /** Fixture floors the tests check (spec "Fixture minimums"; small scaled by PM P2). */
  floors: {
    sentSheets: number;
    openPastShipBy: number;
    shippedPerChannel: number;
    pressedItems: number;
  };
};

const NO_ROLES: Record<Role, number> = {
  owner: 0,
  admin: 0,
  office: 0,
  designer: 0,
  presser: 0,
  packer: 0,
  receiver: 0,
  vendor: 0,
};

export const SCALE_PROFILES: Record<ScaleProfileName, ScaleProfile> = {
  small: {
    name: "small",
    slug: "seed-scale-small",
    companyName: "Seed Scale Small",
    ordersPerDay: 40,
    historyDays: 30,
    itemsMix: [0.7, 0.2, 0.1],
    meanItems: 1.4,
    designs: 12,
    skus: 60,
    roles: { ...NO_ROLES, owner: 1, office: 1, presser: 1 },
    stations: { pick: 0, press: 1, qc: 1, pack: 1 },
    vendors: 1,
    stuckPct: 0.01,
    perSheet: 28,
    floors: { sentSheets: 10, openPastShipBy: 10, shippedPerChannel: 30, pressedItems: 30 },
  },
  mid: {
    name: "mid",
    slug: "seed-scale-mid",
    companyName: "Seed Scale Mid",
    ordersPerDay: 300,
    historyDays: 90,
    itemsMix: [0.6, 0.25, 0.1, 0.05],
    meanItems: 1.6,
    designs: 60,
    skus: 400,
    roles: {
      ...NO_ROLES,
      owner: 1,
      admin: 1,
      office: 1,
      designer: 1,
      presser: 2,
      packer: 1,
      receiver: 1,
    },
    stations: { pick: 1, press: 3, qc: 2, pack: 2 },
    vendors: 2,
    stuckPct: 0.002,
    perSheet: 30,
    floors: { sentSheets: 20, openPastShipBy: 30, shippedPerChannel: 30, pressedItems: 30 },
  },
  large: {
    name: "large",
    slug: "seed-scale-large",
    companyName: "Seed Scale Large",
    ordersPerDay: 1200,
    historyDays: 90,
    itemsMix: [0.6, 0.25, 0.1, 0.05],
    meanItems: 1.6,
    designs: 200,
    skus: 2000,
    roles: {
      ...NO_ROLES,
      owner: 1,
      admin: 2,
      office: 5,
      designer: 3,
      presser: 10,
      packer: 6,
      receiver: 3,
    },
    stations: { pick: 3, press: 9, qc: 4, pack: 4 },
    vendors: 4,
    stuckPct: 0.002,
    perSheet: 30,
    floors: { sentSheets: 200, openPastShipBy: 30, shippedPerChannel: 30, pressedItems: 30 },
  },
};

export function staffCount(p: ScaleProfile): number {
  return Object.values(p.roles).reduce((a, b) => a + b, 0);
}

export function isProfileName(v: string | undefined): v is ScaleProfileName {
  return (SCALE_PROFILE_NAMES as readonly string[]).includes(v ?? "");
}
