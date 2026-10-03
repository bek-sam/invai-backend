import { crc32 } from "node:zlib";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { bucket, getObject, putObject, s3 } from "../../lib/s3";

/*
 * README.txt per channel folder in a photo zip (T-27-3 AC3): which files are AI-generated scenes
 * (Etsy AI-use disclosure) and which carry the XMP synthetic-performer tag (Amazon), in English
 * and Spanish. Imaging's `/photo/zip` only takes images (S-50), so the backend appends the text
 * files to the finished zip as stored entries: it rewrites only the central directory, and a
 * large zip's file data is copied inside S3 (UploadPartCopy), never downloaded.
 */

export type ZipReadmeItem = {
  /** The file's name inside the zip, `<channel>/<file>`. */
  name: string;
  aiGenerated: boolean;
  syntheticPerson: boolean;
};

/** One README per channel folder present in `items`, as `{ name, data }` zip entries. */
export function readmeEntries(items: ZipReadmeItem[]): { name: string; data: Buffer }[] {
  const byChannel = new Map<string, ZipReadmeItem[]>();
  for (const i of items) {
    const channel = i.name.split("/")[0] ?? "";
    if (!channel) continue;
    byChannel.set(channel, [...(byChannel.get(channel) ?? []), i]);
  }
  return [...byChannel].map(([channel, list]) => ({
    name: `${channel}/README.txt`,
    data: Buffer.from(readmeText(list), "utf8"),
  }));
}

const fileName = (i: ZipReadmeItem) => i.name.slice(i.name.indexOf("/") + 1);

function listOr(files: string[], none: string): string[] {
  return files.length ? files.map((f) => `  - ${f}`) : [`  ${none}`];
}

export function readmeText(items: ZipReadmeItem[]): string {
  const ai = items.filter((i) => i.aiGenerated).map(fileName);
  const person = items.filter((i) => i.syntheticPerson).map(fileName);
  const lines = [
    "Listing photos made with InvAI",
    "",
    "AI-generated scenes (the background, garment and any person were drawn by an image model;",
    "your design was placed on top by InvAI, not redrawn):",
    ...listOr(ai, "None. Every photo here is a drawn template, not AI."),
    "",
    "Photos with an AI-generated person (the file carries the XMP tag",
    "'contains-synthetic-performer'):",
    ...listOr(person, "None."),
    "",
    "When you list on Etsy with any AI-generated photo, mark the listing as made with AI.",
    "Drawn template photos are illustrations, not photos of a real product.",
    "",
    "----",
    "",
    "Fotos de anuncio hechas con InvAI",
    "",
    "Escenas generadas con IA (el fondo, la prenda y cualquier persona los dibujó un modelo de",
    "imágenes; InvAI colocó tu diseño encima, sin redibujarlo):",
    ...listOr(ai, "Ninguna. Todas las fotos aquí son plantillas dibujadas, no IA."),
    "",
    "Fotos con una persona generada con IA (el archivo lleva la etiqueta XMP",
    "'contains-synthetic-performer'):",
    ...listOr(person, "Ninguna."),
    "",
    "Si publicas en Etsy con alguna foto generada con IA, marca el anuncio como hecho con IA.",
    "Las fotos de plantilla dibujada son ilustraciones, no fotos de un producto real.",
    "",
  ];
  return lines.join("\r\n");
}

/* ---- Zip append (stored entries, no zip64) ------------------------------------------------ */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const UTF8_FLAG = 0x0800;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;

export type ZipTail = { entries: number; cdSize: number; cdOffset: number; eocdOffset: number };

/** The end-of-central-directory record from the last bytes of a zip (`tailStart` = their offset). */
export function readEocd(tail: Buffer, tailStart: number): ZipTail {
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    const entries = tail.readUInt16LE(i + 10);
    const cdSize = tail.readUInt32LE(i + 12);
    const cdOffset = tail.readUInt32LE(i + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
      throw new Error("zip64 archives are not supported");
    return { entries, cdSize, cdOffset, eocdOffset: tailStart + i };
  }
  throw new Error("not a zip file (no end of central directory)");
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * The bytes that replace everything from the old central directory on: new local entries, the
 * old central directory, the new central entries and a new end record.
 */
export function appendedTail(
  oldCd: Buffer,
  z: ZipTail,
  entries: { name: string; data: Buffer }[],
  now = new Date(),
): Buffer {
  const { time, date } = dosTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = z.cdOffset;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CD_SIG, 0);
    central.writeUInt16LE(0x0314, 4); // made by: unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, e.data);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const newCentral = Buffer.concat(centrals);
  if (offset > 0xffffffff || z.entries + entries.length >= 0xffff)
    throw new Error("zip too large to append to");
  const eocd = Buffer.alloc(EOCD_MIN);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(z.entries + entries.length, 8);
  eocd.writeUInt16LE(z.entries + entries.length, 10);
  eocd.writeUInt32LE(z.cdSize + newCentral.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, oldCd, newCentral, eocd]);
}

/** Appends entries to a whole zip in memory (used for small zips and in tests). */
export function appendToZip(zip: Buffer, entries: { name: string; data: Buffer }[]): Buffer {
  const start = Math.max(0, zip.length - EOCD_SEARCH);
  const z = readEocd(zip.subarray(start), start);
  const oldCd = zip.subarray(z.cdOffset, z.cdOffset + z.cdSize);
  return Buffer.concat([zip.subarray(0, z.cdOffset), appendedTail(oldCd, z, entries)]);
}

/** S3 multipart parts other than the last must be at least 5 MiB. */
const MIN_PART = 5 * 1024 * 1024;

async function getRange(key: string, start: number, end: number): Promise<Buffer> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }),
  );
  return Buffer.from((await res.Body?.transformToByteArray()) ?? []);
}

/**
 * Appends entries to the zip stored at `key`, in place. Small zips are rewritten from memory;
 * large ones keep their file data in S3 (part 1 copied server side) and upload only the tail.
 */
export async function appendToStoredZip(
  key: string,
  entries: { name: string; data: Buffer }[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const size = head.ContentLength ?? 0;
  const tailStart = Math.max(0, size - EOCD_SEARCH);
  const z = readEocd(await getRange(key, tailStart, size - 1), tailStart);
  if (z.cdOffset < MIN_PART) {
    const out = appendToZip(await getObject(key), entries);
    await putObject(key, out, "application/zip");
    return out.length;
  }
  const oldCd = z.cdSize
    ? await getRange(key, z.cdOffset, z.cdOffset + z.cdSize - 1)
    : Buffer.alloc(0);
  const tail = appendedTail(oldCd, z, entries);
  const mpu = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: "application/zip" }),
  );
  const uploadId = mpu.UploadId;
  if (!uploadId) throw new Error("multipart upload did not start");
  try {
    const p1 = await s3.send(
      new UploadPartCopyCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        CopySource: `${bucket}/${key}`,
        CopySourceRange: `bytes=0-${z.cdOffset - 1}`,
      }),
    );
    const p2 = await s3.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 2,
        Body: tail,
      }),
    );
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: p1.CopyPartResult?.ETag },
            { PartNumber: 2, ETag: p2.ETag },
          ],
        },
      }),
    );
  } catch (err) {
    await s3
      .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
      .catch(() => undefined);
    throw err;
  }
  return z.cdOffset + tail.length;
}
