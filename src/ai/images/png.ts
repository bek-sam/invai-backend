import { deflateSync, inflateSync } from "node:zlib";

/*
 * A small PNG codec for the mock image provider (no image library in the backend; pixels belong
 * to invai-imaging). Decodes non-interlaced 8- and 16-bit gray, gray+alpha, RGB, RGBA and 8-bit
 * palette images to RGBA; encodes 8-bit RGB or RGBA. Deterministic: same pixels, same bytes.
 */

export type Rgba = { width: number; height: number; data: Uint8Array };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buf: Buffer): boolean {
  return buf.length > 24 && buf.subarray(0, 8).equals(SIGNATURE);
}

/** Width and height from the IHDR chunk, without decoding pixels. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (!isPng(buf)) throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(buf: Buffer): Rgba {
  if (!isPng(buf)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8] ?? 0;
      colorType = body[9] ?? 0;
      if (body[12] !== 0) throw new Error("interlaced PNG is not supported");
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const channels = CHANNELS[colorType];
  if (!channels || !width || !height) throw new Error("unsupported PNG header");
  if (!(depth === 8 || (depth === 16 && colorType !== 3))) {
    throw new Error(`unsupported PNG bit depth ${depth}`);
  }
  if (width * height > 40_000_000) throw new Error("PNG too large");
  const bpp = (channels * depth) / 8;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error("truncated PNG data");
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x] ?? 0;
      const a = x >= bpp ? (px[dst + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (px[dst - stride + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (px[dst - stride + x - bpp] ?? 0) : 0;
      let out: number;
      if (filter === 0) out = v;
      else if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`bad PNG filter ${filter}`);
      px[dst + x] = out & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  const step = depth / 8; // 16-bit samples: keep the high byte
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp;
    const sample = (k: number) => px[s + k * step] ?? 0;
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (colorType === 0) {
      r = g = b = sample(0);
    } else if (colorType === 4) {
      r = g = b = sample(0);
      a = sample(1);
    } else if (colorType === 2) {
      r = sample(0);
      g = sample(1);
      b = sample(2);
    } else if (colorType === 6) {
      r = sample(0);
      g = sample(1);
      b = sample(2);
      a = sample(3);
    } else {
      const idx = sample(0);
      r = palette?.[idx * 3] ?? 0;
      g = palette?.[idx * 3 + 1] ?? 0;
      b = palette?.[idx * 3 + 2] ?? 0;
      a = trns && idx < trns.length ? (trns[idx] ?? 255) : 255;
    }
    data.set([r, g, b, a], i * 4);
  }
  return { width, height, data };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encodes RGBA pixels as 8-bit RGBA (`alpha`) or RGB (alpha dropped), filter "up" per row. */
export function encodePng(img: Rgba, opts: { alpha?: boolean } = {}): Buffer {
  const { width, height, data } = img;
  const channels = opts.alpha ? 4 : 3;
  const stride = width * channels;
  const rows = Buffer.alloc(height * (stride + 1));
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < channels; k++) cur[x * channels + k] = data[(y * width + x) * 4 + k] ?? 0;
    }
    const o = y * (stride + 1);
    rows[o] = 2;
    for (let i = 0; i < stride; i++) rows[o + 1 + i] = ((cur[i] ?? 0) - (prev[i] ?? 0)) & 0xff;
    prev.set(cur);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opts.alpha ? 6 : 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
