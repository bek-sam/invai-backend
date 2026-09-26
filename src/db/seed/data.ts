import type { TemplateSlot } from "../schema";

/** Deterministic PRNG (mulberry32) so every `db:seed` produces the same demo. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)] as T,
    chance: (p: number) => next() < p,
  };
}

export const SIZES = [
  { size: "S", code: "S", upcharge: 0, weightAdd: 0 },
  { size: "M", code: "M", upcharge: 0, weightAdd: 0.4 },
  { size: "L", code: "L", upcharge: 0, weightAdd: 0.8 },
  { size: "XL", code: "XL", upcharge: 0, weightAdd: 1.2 },
  { size: "2XL", code: "2XL", upcharge: 180, weightAdd: 1.8 },
  { size: "3XL", code: "3XL", upcharge: 260, weightAdd: 2.4 },
] as const;

export type BlankStyleSeed = {
  brand: string;
  style: string;
  styleCode: string;
  styleName: string;
  baseCostCents: number;
  baseWeightOz: number;
  supplierPrefix: string;
  colors: { name: string; code: string; hex: string; ss: string }[];
};

export const BLANK_STYLES: BlankStyleSeed[] = [
  {
    brand: "Gildan",
    style: "64000",
    styleCode: "G64000",
    styleName: "Softstyle T-Shirt",
    baseCostCents: 289,
    baseWeightOz: 5.3,
    supplierPrefix: "B0076",
    colors: [
      { name: "Black", code: "BLK", hex: "#1a1a1a", ss: "0036" },
      { name: "White", code: "WHT", hex: "#f7f7f5", ss: "0001" },
      { name: "Sport Grey", code: "SGR", hex: "#a5a7a6", ss: "0095" },
      { name: "Navy", code: "NVY", hex: "#1f2a44", ss: "0032" },
      { name: "Heather Military Green", code: "HMG", hex: "#5f6b52", ss: "0134" },
      { name: "Sand", code: "SND", hex: "#d9c8a9", ss: "0178" },
    ],
  },
  {
    brand: "Comfort Colors",
    style: "1717",
    styleCode: "CC1717",
    styleName: "Garment-Dyed Heavyweight T-Shirt",
    baseCostCents: 689,
    baseWeightOz: 7.1,
    supplierPrefix: "B0017",
    colors: [
      { name: "Pepper", code: "PEP", hex: "#4a4a48", ss: "1040" },
      { name: "Ivory", code: "IVY", hex: "#f0eadc", ss: "1002" },
      { name: "Blue Jean", code: "BLJ", hex: "#7891b0", ss: "1013" },
      { name: "Crimson", code: "CRM", hex: "#a4343a", ss: "1027" },
      { name: "Moss", code: "MOS", hex: "#7f8c6c", ss: "1031" },
      { name: "Terracotta", code: "TER", hex: "#c8724f", ss: "1075" },
    ],
  },
  {
    brand: "Bella+Canvas",
    style: "3001",
    styleCode: "BC3001",
    styleName: "Unisex Jersey Short Sleeve Tee",
    baseCostCents: 459,
    baseWeightOz: 4.2,
    supplierPrefix: "B0030",
    colors: [
      { name: "Black", code: "BLK", hex: "#151515", ss: "3001" },
      { name: "White", code: "WHT", hex: "#fafafa", ss: "3002" },
      { name: "Athletic Heather", code: "ATH", hex: "#b7b9ba", ss: "3010" },
      { name: "Heather Mauve", code: "HMV", hex: "#b48a8a", ss: "3048" },
      { name: "Dusty Blue", code: "DSB", hex: "#8ea9c1", ss: "3061" },
      { name: "Mustard", code: "MST", hex: "#d9a021", ss: "3073" },
    ],
  },
];

/** Print sizes (inches) as a real shop sells them; the mix keeps 22 in gang sheets dense. */
export type PrintSize = {
  kind: "adult" | "youth" | "left_chest" | "sleeve" | "back";
  placement: "front" | "back" | "left_chest" | "sleeve_left";
  widthIn: number;
  heightIn: number;
};
export const PRINT_SIZES: Record<PrintSize["kind"], PrintSize> = {
  adult: { kind: "adult", placement: "front", widthIn: 10.5, heightIn: 12 },
  youth: { kind: "youth", placement: "front", widthIn: 8.5, heightIn: 9.5 },
  left_chest: { kind: "left_chest", placement: "left_chest", widthIn: 3.75, heightIn: 3.75 },
  sleeve: { kind: "sleeve", placement: "sleeve_left", widthIn: 3, heightIn: 10 },
  back: { kind: "back", placement: "back", widthIn: 12, heightIn: 14 },
};
/** Personalized templates render at this size. */
export const TEMPLATE_SIZE = PRINT_SIZES.adult;
const SIZE_MIX: PrintSize["kind"][] = [
  "adult",
  "adult",
  "adult",
  "youth",
  "adult",
  "left_chest",
  "adult",
  "back",
  "adult",
  "sleeve",
];

export type DesignSeed = {
  code: string;
  name: string;
  tags: string[];
  color: string;
  template?: number;
  size: PrintSize;
};

const D = (
  code: string,
  name: string,
  tags: string[],
  color: string,
  template?: number,
): DesignSeed => ({
  code,
  name,
  tags,
  color,
  template,
  size:
    template === undefined
      ? PRINT_SIZES[SIZE_MIX[(Number.parseInt(code.slice(2), 10) - 1) % SIZE_MIX.length] ?? "adult"]
      : TEMPLATE_SIZE,
});

export const DESIGNS: DesignSeed[] = [
  D("DB001", "Saguaro Sunset", ["desert", "cactus", "sunset"], "#c8724f"),
  D("DB002", "Desert Bloom Logo", ["brand", "flower"], "#d9a021"),
  D("DB003", "Wild & Free Coyote", ["desert", "animal", "retro"], "#5f6b52"),
  D("DB004", "Arizona Est. 1912", ["arizona", "vintage"], "#a4343a"),
  D("DB005", "Sedona Red Rocks", ["arizona", "travel", "retro"], "#b0522f"),
  D("DB006", "Cactus Mama", ["mom", "cactus"], "#7f8c6c"),
  D("DB007", "Sun's Out Buns Out", ["summer", "funny"], "#e0a020"),
  D("DB008", "Grand Canyon Vibes", ["arizona", "travel"], "#8b5a3c"),
  D("DB009", "Prickly But Cute", ["cactus", "funny", "cute"], "#c46b8a"),
  D("DB010", "Monsoon Season", ["arizona", "weather"], "#4e6d8c"),
  D("DB011", "Roadrunner Club", ["animal", "retro"], "#3f6d9a"),
  D("DB012", "Phoenix Rising", ["phoenix", "bird"], "#d1552b"),
  D("DB013", "Boho Moon Phases", ["boho", "moon"], "#3c3a4a"),
  D("DB014", "Hike More Worry Less", ["hiking", "outdoors"], "#4f7a5c"),
  D("DB015", "Camp Life Lantern", ["camping", "outdoors"], "#8a6b3f"),
  D("DB016", "Dog Mom Era", ["dog", "mom"], "#b5533c"),
  D("DB017", "Cat Dad", ["cat", "dad"], "#556677"),
  D("DB018", "Coffee Then Cactus", ["coffee", "cactus"], "#6b4a2e"),
  D("DB019", "Retro Rainbow Wave", ["retro", "wave"], "#e07a5f"),
  D("DB020", "Tucson Old Pueblo", ["arizona", "vintage"], "#9c5b3a"),
  D("DB021", "Howdy Cowgirl", ["western", "cowgirl"], "#c98a4b"),
  D("DB022", "Rodeo Nights", ["western", "rodeo"], "#7a4b2a"),
  D("DB023", "Wildflower Meadow", ["flower", "boho"], "#c46b8a"),
  D("DB024", "Golden Hour", ["sunset", "boho"], "#d9a021"),
  D("DB025", "Bride Tribe Cactus", ["bride", "bachelorette"], "#d4a5b5", 0),
  D("DB026", "Family Reunion Saguaro", ["family", "reunion"], "#4f7a5c", 1),
  D("DB027", "Senior Class Sun", ["senior", "graduate"], "#1f2a44", 2),
  D("DB028", "Pumpkin Spice Desert", ["fall", "pumpkin"], "#d1552b"),
  D("DB029", "Spooky Saguaro", ["halloween", "spooky"], "#3c3a4a"),
  D("DB030", "Desert Christmas Lights", ["christmas", "cactus"], "#2e6b3f"),
  D("DB031", "Teacher Of Tiny Cacti", ["teacher", "cactus"], "#5f8a6e"),
  D("DB032", "Nurse Life Sunrise", ["nurse"], "#c46b8a"),
  D("DB033", "Fishing The Salt River", ["fishing", "outdoors"], "#3f6d9a"),
  D("DB034", "Baseball Mom Bloom", ["baseball", "mom"], "#a4343a"),
  D("DB035", "Soccer Season", ["soccer"], "#2e6b3f"),
  D("DB036", "Dance Team Cactus", ["dance", "cheer"], "#b48a8a"),
  D("DB037", "Vintage Route 66 Diner", ["vintage", "retro"], "#8b5a3c"),
  D("DB038", "Blessed & Sun-Kissed", ["faith", "summer"], "#e0a020"),
  D("DB039", "Good Vibes Only Agave", ["vibes", "boho"], "#7f8c6c"),
  D("DB040", "Lake Powell Weekend", ["vacation", "lake"], "#4e6d8c"),
];

const textSlot = (
  name: string,
  y: number,
  size: number,
  extra: Partial<TemplateSlot> = {},
): TemplateSlot => ({
  name,
  kind: "text",
  xIn: 0.5,
  yIn: y,
  wIn: 10,
  hIn: 1.6,
  fontFamily: "Inter",
  fontSizePt: size,
  minFontSizePt: null,
  maxLines: null,
  strokeWidthPt: 0,
  strokeColor: null,
  fit: "fit",
  color: "#1a1a1a",
  align: "center",
  maxChars: 24,
  uppercase: false,
  sourceQuestion: null,
  required: true,
  placeholder: null,
  ...extra,
});

export const TEMPLATES: {
  name: string;
  widthIn: number;
  heightIn: number;
  slots: TemplateSlot[];
}[] = [
  {
    name: "Bride Tribe (name + date)",
    widthIn: TEMPLATE_SIZE.widthIn,
    heightIn: TEMPLATE_SIZE.heightIn,
    slots: [
      textSlot("name", 8.2, 48, { sourceQuestion: "name", uppercase: true, maxChars: 16 }),
      textSlot("date", 10.0, 24, { sourceQuestion: "date", required: false, placeholder: "2026" }),
    ],
  },
  {
    name: "Family Reunion (family name + year)",
    widthIn: TEMPLATE_SIZE.widthIn,
    heightIn: TEMPLATE_SIZE.heightIn,
    slots: [
      textSlot("family", 1.0, 44, { sourceQuestion: "family name", uppercase: true, maxChars: 18 }),
      textSlot("year", 10.2, 28, { sourceQuestion: "year", maxChars: 4 }),
    ],
  },
  {
    name: "Senior (school + class of)",
    widthIn: TEMPLATE_SIZE.widthIn,
    heightIn: TEMPLATE_SIZE.heightIn,
    slots: [
      textSlot("school", 1.2, 40, { sourceQuestion: "school", uppercase: true, maxChars: 22 }),
      textSlot("year", 9.8, 34, { sourceQuestion: "class of", maxChars: 4 }),
    ],
  },
];

export const FIRST_NAMES = [
  "Emma",
  "Liam",
  "Olivia",
  "Noah",
  "Ava",
  "Mason",
  "Sophia",
  "Ethan",
  "Isabella",
  "Lucas",
  "Mia",
  "Aiden",
  "Harper",
  "Elijah",
  "Evelyn",
  "James",
  "Abigail",
  "Benjamin",
  "Emily",
  "Logan",
  "Maria",
  "Carlos",
  "Sofia",
  "Diego",
  "Valentina",
  "Mateo",
  "Camila",
  "Santiago",
  "Lucia",
  "Andres",
  "Grace",
  "Henry",
  "Chloe",
  "Jack",
  "Zoe",
  "Owen",
  "Lily",
  "Wyatt",
  "Hannah",
  "Caleb",
];

export const LAST_NAMES = [
  "Johnson",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
  "Moore",
  "Jackson",
  "Martin",
  "Lee",
  "Perez",
  "Thompson",
  "White",
  "Harris",
  "Sanchez",
  "Clark",
  "Ramirez",
  "Lewis",
  "Robinson",
  "Walker",
  "Young",
  "Allen",
  "King",
  "Wright",
  "Scott",
  "Torres",
  "Nguyen",
  "Hill",
  "Flores",
  "Green",
  "Adams",
  "Nelson",
  "Baker",
  "Hall",
];

export const CITIES: { city: string; state: string; zip: string }[] = [
  { city: "Phoenix", state: "AZ", zip: "85004" },
  { city: "Scottsdale", state: "AZ", zip: "85251" },
  { city: "Tucson", state: "AZ", zip: "85701" },
  { city: "Mesa", state: "AZ", zip: "85201" },
  { city: "Flagstaff", state: "AZ", zip: "86001" },
  { city: "Los Angeles", state: "CA", zip: "90012" },
  { city: "San Diego", state: "CA", zip: "92101" },
  { city: "Las Vegas", state: "NV", zip: "89101" },
  { city: "Denver", state: "CO", zip: "80202" },
  { city: "Austin", state: "TX", zip: "78701" },
  { city: "Dallas", state: "TX", zip: "75201" },
  { city: "Houston", state: "TX", zip: "77002" },
  { city: "Nashville", state: "TN", zip: "37203" },
  { city: "Atlanta", state: "GA", zip: "30303" },
  { city: "Orlando", state: "FL", zip: "32801" },
  { city: "Tampa", state: "FL", zip: "33602" },
  { city: "Chicago", state: "IL", zip: "60604" },
  { city: "Columbus", state: "OH", zip: "43215" },
  { city: "Charlotte", state: "NC", zip: "28202" },
  { city: "Seattle", state: "WA", zip: "98101" },
  { city: "Portland", state: "OR", zip: "97204" },
  { city: "Salt Lake City", state: "UT", zip: "84111" },
  { city: "Albuquerque", state: "NM", zip: "87102" },
  { city: "Kansas City", state: "MO", zip: "64106" },
  { city: "Minneapolis", state: "MN", zip: "55401" },
  { city: "Boston", state: "MA", zip: "02108" },
  { city: "Brooklyn", state: "NY", zip: "11201" },
  { city: "Philadelphia", state: "PA", zip: "19107" },
  { city: "Pittsburgh", state: "PA", zip: "15222" },
  { city: "Indianapolis", state: "IN", zip: "46204" },
];

export const STREETS = [
  "Main St",
  "Oak Ave",
  "Maple Dr",
  "Cedar Ln",
  "Desert View Rd",
  "Camelback Rd",
  "Sunset Blvd",
  "Palm Way",
  "Mesquite Ct",
  "Canyon Trail",
  "Ridge Rd",
  "River St",
  "Lakeview Dr",
  "Hilltop Ave",
];

export const PERSONALIZATION_ANSWERS = [
  {
    name: "Ashley",
    date: "10.12.2026",
    family: "Ramirez",
    year: "2026",
    school: "Desert Vista",
    "class of": "2027",
  },
  {
    name: "Brooke",
    date: "11.02.2026",
    family: "Thompson",
    year: "2026",
    school: "Chaparral",
    "class of": "2027",
  },
  {
    name: "Jasmine",
    date: "",
    family: "Nguyen",
    year: "2027",
    school: "Mountain Pointe",
    "class of": "2026",
  },
  {
    name: "Megan",
    date: "04.18.2027",
    family: "Walker Family Reunion",
    year: "2026",
    school: "Hamilton",
    "class of": "2027",
  },
];
