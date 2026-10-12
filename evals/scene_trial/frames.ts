import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePng } from "../../src/ai/images/png";
import { getObject } from "../../src/lib/s3";

/*
 * Per-frame evidence of the scene trial (T-38-2 phase 2): which mask was sent (share of fully
 * opaque pixels = the kept area, and a short hash of the PNG) and a copy of the frame files for
 * the offline calibration script. Never opens an image for a person; numbers only.
 */

export function maskStats(png: Buffer): { alpha255Share: number; hash: string } {
  const img = decodePng(png);
  let kept = 0;
  const px = img.width * img.height;
  for (let i = 0; i < px; i++) if (img.data[i * 4 + 3] === 255) kept++;
  return {
    alpha255Share: px ? kept / px : 0,
    hash: createHash("sha256").update(png).digest("hex").slice(0, 12),
  };
}

/** Copies the listed storage keys into `<dir>/scenes/` under their file names. */
export async function copyKeys(dir: string, keys: string[]): Promise<void> {
  await mkdir(join(dir, "scenes"), { recursive: true });
  for (const key of keys) {
    const name = key.split("/").at(-1) as string;
    await writeFile(join(dir, "scenes", name), await getObject(key));
  }
}
