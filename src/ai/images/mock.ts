import { createHash } from "node:crypto";
import type { PhotoSceneKind } from "@invai/contracts";
import { env } from "../../env";
import { MOCK_IMAGE_MODEL } from "../models";
import { decodePng, encodePng, type Rgba } from "./png";
import { providerSize } from "./sizes";
import {
  type GeneratedScene,
  type GenerateSceneInput,
  ImageGenError,
  type ImageProvider,
} from "./types";

/*
 * Mock image provider (T-27-1 AC3): free, deterministic (same base, mask and prompt give the same
 * bytes) and shaped like the real model's output, so imaging's lock checks see what they will
 * see in production:
 *  - output at one of the provider sizes, the base scaled to fit and centered (outline in place);
 *  - the base's background (its corner color, or transparent) replaced by a scene per kind:
 *    gradient backdrop, a soft light spot and a few simple props;
 *  - the whole frame perturbed slightly (light falloff and +-2 noise), as a re-render would be;
 *  - IMAGE_GEN_MOCK_DRIFT=1 (tests only) paints stripes over the protected print area and a ring
 *    around it, so imaging's region check fails and the drift path can be exercised.
 */

type Palette = {
  top: [number, number, number];
  bottom: [number, number, number];
  prop: [number, number, number][];
};

const PALETTES: Record<PhotoSceneKind, Palette> = {
  studio: { top: [236, 236, 238], bottom: [206, 206, 210], prop: [[180, 180, 186]] },
  home: {
    top: [240, 228, 210],
    bottom: [196, 170, 140],
    prop: [
      [92, 140, 88],
      [160, 120, 90],
    ],
  },
  outdoor: {
    top: [170, 210, 240],
    bottom: [110, 160, 90],
    prop: [
      [70, 120, 60],
      [90, 140, 70],
    ],
  },
  street: {
    top: [200, 196, 190],
    bottom: [120, 118, 116],
    prop: [
      [150, 80, 60],
      [90, 90, 96],
    ],
  },
  cafe: {
    top: [214, 180, 140],
    bottom: [120, 84, 56],
    prop: [
      [240, 236, 228],
      [90, 60, 40],
    ],
  },
  workplace: {
    top: [232, 236, 240],
    bottom: [180, 186, 196],
    prop: [
      [150, 110, 70],
      [70, 90, 120],
    ],
  },
  flat_lay: {
    top: [222, 196, 160],
    bottom: [200, 170, 132],
    prop: [
      [60, 130, 70],
      [40, 40, 44],
      [240, 240, 236],
    ],
  },
};

/** mulberry32: a tiny seeded PRNG, so the mock is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scales `src` to fit (W, H) preserving aspect, centered; uncovered pixels are transparent. */
function fitInto(src: Rgba, W: number, H: number): Rgba {
  const scale = Math.min(W / src.width, H / src.height);
  const w = src.width * scale;
  const h = src.height * scale;
  const ox = (W - w) / 2;
  const oy = (H - h) / 2;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = (y + 0.5 - oy) / scale - 0.5;
    if (sy < -0.5 || sy > src.height - 0.5) continue;
    const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(sy)));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < W; x++) {
      const sx = (x + 0.5 - ox) / scale - 0.5;
      if (sx < -0.5 || sx > src.width - 0.5) continue;
      const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(sx)));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      for (let k = 0; k < 4; k++) {
        const p = (yy: number, xx: number) => src.data[(yy * src.width + xx) * 4 + k] ?? 0;
        const top = p(y0, x0) * (1 - fx) + p(y0, x1) * fx;
        const bot = p(y1, x0) * (1 - fx) + p(y1, x1) * fx;
        out[(y * W + x) * 4 + k] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return { width: W, height: H, data: out };
}

function cornerColor(img: Rgba): [number, number, number] {
  const pts = [
    [0, 0],
    [img.width - 1, 0],
    [0, img.height - 1],
    [img.width - 1, img.height - 1],
  ];
  const sum = [0, 0, 0];
  for (const [x, y] of pts) {
    const i = ((y ?? 0) * img.width + (x ?? 0)) * 4;
    for (let k = 0; k < 3; k++) sum[k] = (sum[k] ?? 0) + (img.data[i + k] ?? 0);
  }
  return [(sum[0] ?? 0) / 4, (sum[1] ?? 0) / 4, (sum[2] ?? 0) / 4];
}

function seedOf(input: GenerateSceneInput): number {
  const h = createHash("sha256")
    .update(input.baseImage)
    .update(input.mask)
    .update(input.prompt.text)
    .digest();
  return h.readUInt32BE(0);
}

export function renderMockScene(input: GenerateSceneInput, drift: boolean): Rgba {
  let base: Rgba;
  let mask: Rgba;
  try {
    base = decodePng(input.baseImage);
    mask = decodePng(input.mask);
  } catch (err) {
    throw new ImageGenError(`mock image provider: ${(err as Error).message}`, false);
  }
  const size = providerSize(input.sizePx);
  const W = size.width;
  const H = size.height;
  const rand = rng(seedOf(input));
  const bg = cornerColor(base);
  const b = fitInto(base, W, H);
  const m = fitInto(mask, W, H);
  const pal = PALETTES[input.prompt.sceneKind];
  const out = new Uint8Array(W * H * 4);

  // Light spot and props, all placed from the seed.
  const lx = W * (0.2 + 0.6 * rand());
  const ly = H * (0.1 + 0.3 * rand());
  const lr = Math.max(W, H) * 0.6;
  const props = Array.from({ length: 2 + Math.floor(rand() * 3) }, (_, i) => ({
    x: W * (rand() < 0.5 ? 0.04 + 0.18 * rand() : 0.78 + 0.18 * rand()),
    y: H * (0.55 + 0.4 * rand()),
    r: Math.min(W, H) * (0.04 + 0.06 * rand()),
    round: rand() < 0.5,
    color: pal.prop[i % pal.prop.length] ?? [128, 128, 128],
  }));

  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Scene backdrop: vertical gradient + light spot.
      let sr = pal.top[0] * (1 - t) + pal.bottom[0] * t;
      let sg = pal.top[1] * (1 - t) + pal.bottom[1] * t;
      let sb = pal.top[2] * (1 - t) + pal.bottom[2] * t;
      const d = Math.hypot(x - lx, y - ly) / lr;
      const light = 1 + 0.12 * Math.max(0, 1 - d);
      sr *= light;
      sg *= light;
      sb *= light;
      for (const p of props) {
        const inside = p.round
          ? Math.hypot(x - p.x, y - p.y) <= p.r
          : Math.abs(x - p.x) <= p.r && Math.abs(y - p.y) <= p.r * 0.6;
        if (inside) [sr, sg, sb] = p.color;
      }
      // How much of the base is background (transparent, or close to its corner color).
      const ba = (b.data[i + 3] ?? 0) / 255;
      const dist = Math.hypot(
        (b.data[i] ?? 0) - bg[0],
        (b.data[i + 1] ?? 0) - bg[1],
        (b.data[i + 2] ?? 0) - bg[2],
      );
      const isBg = Math.max(1 - ba, Math.max(0, Math.min(1, (28 - dist) / 14)));
      // Protected (mask opaque) pixels always keep the base.
      const protectedW = (m.data[i + 3] ?? 0) / 255;
      const sceneW = isBg * (1 - protectedW);
      // Whole-frame re-render: slight light falloff and +-2 noise everywhere.
      const falloff = 1 - 0.025 * (Math.abs(x / W - 0.5) + Math.abs(t - 0.5));
      const noise = () => Math.floor(rand() * 5) - 2;
      out[i] = clamp((b.data[i] ?? 0) * (1 - sceneW) + sr * sceneW, falloff, noise());
      out[i + 1] = clamp((b.data[i + 1] ?? 0) * (1 - sceneW) + sg * sceneW, falloff, noise());
      out[i + 2] = clamp((b.data[i + 2] ?? 0) * (1 - sceneW) + sb * sceneW, falloff, noise());
      out[i + 3] = 255;
    }
  }
  if (drift) paintDrift(out, m, W, H);
  return { width: W, height: H, data: out };
}

function clamp(v: number, falloff: number, noise: number): number {
  return Math.max(0, Math.min(255, Math.round(v * falloff + noise)));
}

/** Test drift: diagonal stripes over the protected area's box, grown by 4% of the short side. */
function paintDrift(out: Uint8Array, m: Rgba, W: number, H: number) {
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((m.data[(y * W + x) * 4 + 3] ?? 0) > 127) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return;
  const g = Math.round(Math.min(W, H) * 0.04);
  for (let y = Math.max(0, y0 - g); y <= Math.min(H - 1, y1 + g); y++) {
    for (let x = Math.max(0, x0 - g); x <= Math.min(W - 1, x1 + g); x++) {
      const on = Math.floor((x + y) / 12) % 2 === 0;
      const i = (y * W + x) * 4;
      out[i] = on ? 230 : 20;
      out[i + 1] = on ? 30 : 20;
      out[i + 2] = on ? 40 : 200;
    }
  }
}

export const mockImageProvider: ImageProvider = {
  name: "mock",
  model: MOCK_IMAGE_MODEL,
  estimateCents: () => 0,
  async generateScene(input): Promise<GeneratedScene> {
    const img = renderMockScene(input, env.imageGenMockDrift);
    return {
      image: encodePng(img),
      widthPx: img.width,
      heightPx: img.height,
      provider: "mock",
      model: MOCK_IMAGE_MODEL,
      costCents: 0,
      containsPerson: input.prompt.containsPerson,
    };
  },
};
