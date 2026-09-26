import { open } from "node:fs/promises";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/*
 * A minimal ZIP (PKWARE APPNOTE 6.3) writer for the tenant export: entries are appended to a
 * file on disk one at a time, so memory holds one entry, never the whole archive. No ZIP64: an
 * archive stops at 4 GiB and 65,535 entries (`ZipLimitError`), which the export job reports as a
 * permanent failure. The dependency-free reader below is for tests and the verification script.
 */

const ZIP32_MAX = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;
const UTF8_FLAG = 0x0800;

export class ZipLimitError extends Error {}

type Entry = {
  name: Buffer;
  crc: number;
  method: number;
  csize: number;
  usize: number;
  offset: number;
};

/** DOS date and time for "now" (the spec has no time zone; UTC keeps exports reproducible). */
function dosDateTime(d = new Date()): { time: number; date: number } {
  const time =
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

export async function createZip(path: string) {
  const fh = await open(path, "w");
  const entries: Entry[] = [];
  let offset = 0;
  const { time, date } = dosDateTime();

  async function write(buf: Buffer) {
    if (offset + buf.length > ZIP32_MAX) throw new ZipLimitError("export is larger than 4 GiB");
    await fh.write(buf);
    offset += buf.length;
  }

  return {
    /** Add one file. `compress` deflates it (text); already-compressed images are stored as is. */
    async add(name: string, data: Buffer, compress = true) {
      if (entries.length >= MAX_ENTRIES) throw new ZipLimitError("export has too many files");
      const nameBuf = Buffer.from(name, "utf8");
      const body = compress ? deflateRawSync(data) : data;
      const entry: Entry = {
        name: nameBuf,
        crc: crc32(data) >>> 0,
        method: compress ? 8 : 0,
        csize: body.length,
        usize: data.length,
        offset,
      };
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(UTF8_FLAG, 6);
      h.writeUInt16LE(entry.method, 8);
      h.writeUInt16LE(time, 10);
      h.writeUInt16LE(date, 12);
      h.writeUInt32LE(entry.crc, 14);
      h.writeUInt32LE(entry.csize, 18);
      h.writeUInt32LE(entry.usize, 22);
      h.writeUInt16LE(nameBuf.length, 26);
      h.writeUInt16LE(0, 28);
      await write(Buffer.concat([h, nameBuf]));
      await write(body);
      entries.push(entry);
    },
    /** Write the central directory and close the file. Returns the archive size in bytes. */
    async finish(): Promise<number> {
      const cdStart = offset;
      for (const e of entries) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(UTF8_FLAG, 8);
        c.writeUInt16LE(e.method, 10);
        c.writeUInt16LE(time, 12);
        c.writeUInt16LE(date, 14);
        c.writeUInt32LE(e.crc, 16);
        c.writeUInt32LE(e.csize, 20);
        c.writeUInt32LE(e.usize, 24);
        c.writeUInt16LE(e.name.length, 28);
        c.writeUInt32LE(e.offset, 42);
        await write(Buffer.concat([c, e.name]));
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(entries.length, 8);
      end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(offset - cdStart, 12);
      end.writeUInt32LE(cdStart, 16);
      await write(end);
      await fh.close();
      return offset;
    },
    async abort() {
      await fh.close().catch(() => {});
    },
  };
}

/** Read every entry of a ZIP written by `createZip` (or any non-ZIP64 archive without comments). */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) >>> 0 !== crc) throw new Error(`crc mismatch for ${name}`);
    out.set(name, data);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
