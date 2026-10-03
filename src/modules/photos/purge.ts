import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { withSystem, withTenant } from "../../db/client";
import { photoCompositions, photoSets } from "../../db/schema";
import { errorData, logger } from "../../lib/log";
import { deleteObject, isCompanyKey } from "../../lib/s3";

/*
 * Photo retention (ADR 0023 §9, T-27-3): raw provider scenes with their base and mask are
 * deleted 7 days after the scene was made (kept that long for drift review); zips 30 days after
 * they were built (rebuilt on demand: the set's zip goes back to `none`). Rendered images follow
 * the design. Safe to run twice: rows are marked, and a missing object deletes as a no-op.
 */

const log = logger("photos.purge");

export const RAW_SCENE_RETENTION_DAYS = 7;
export const ZIP_RETENTION_DAYS = 30;
const BATCH = 500;

const sceneObjects = (c: {
  companyId: string;
  setId: string;
  id: string;
  sceneBaseKey: string | null;
  sceneMaskKey: string | null;
}) =>
  [
    c.sceneBaseKey,
    c.sceneMaskKey,
    `${c.companyId}/photos/${c.setId}/scenes/${c.id}-a1.png`,
    `${c.companyId}/photos/${c.setId}/scenes/${c.id}-a2.png`,
  ].filter((k): k is string => !!k && isCompanyKey(c.companyId, k));

async function remove(keys: string[]): Promise<number> {
  let n = 0;
  for (const key of keys) {
    try {
      await deleteObject(key);
      n++;
    } catch (err) {
      log.warn("photo object delete failed", { key, ...errorData(err) });
    }
  }
  return n;
}

export async function purgePhotoFiles(now = new Date()) {
  const sceneCutoff = new Date(now.getTime() - RAW_SCENE_RETENTION_DAYS * 86_400_000);
  const zipCutoff = new Date(now.getTime() - ZIP_RETENTION_DAYS * 86_400_000);
  // withSystem: a scheduled cross-tenant job that only reads ids and keys here, then writes per
  // tenant under withTenant (same pattern as the buyer PII purge).
  const scenes = await withSystem((tx) =>
    tx
      .select({
        id: photoCompositions.id,
        companyId: photoCompositions.companyId,
        setId: photoCompositions.setId,
        sceneBaseKey: photoCompositions.sceneBaseKey,
        sceneMaskKey: photoCompositions.sceneMaskKey,
      })
      .from(photoCompositions)
      .where(
        and(
          eq(photoCompositions.source, "ai_scene"),
          isNull(photoCompositions.scenePurgedAt),
          isNotNull(photoCompositions.sceneBaseKey),
          lt(photoCompositions.createdAt, sceneCutoff),
        ),
      )
      .limit(BATCH),
  );
  const zips = await withSystem((tx) =>
    tx
      .select({ id: photoSets.id, companyId: photoSets.companyId, zipKey: photoSets.zipKey })
      .from(photoSets)
      .where(and(eq(photoSets.zipStatus, "ready"), lt(photoSets.zipBuiltAt, zipCutoff)))
      .limit(BATCH),
  );
  let objects = 0;
  const byCompany = new Map<string, { scenes: string[]; sets: string[] }>();
  const of = (id: string) => {
    const e = byCompany.get(id) ?? { scenes: [], sets: [] };
    byCompany.set(id, e);
    return e;
  };
  for (const c of scenes) {
    objects += await remove(sceneObjects(c));
    of(c.companyId).scenes.push(c.id);
  }
  for (const s of zips) {
    if (s.zipKey && isCompanyKey(s.companyId, s.zipKey)) objects += await remove([s.zipKey]);
    of(s.companyId).sets.push(s.id);
  }
  for (const [companyId, e] of byCompany) {
    await withTenant(companyId, async (tx) => {
      if (e.scenes.length)
        await tx
          .update(photoCompositions)
          .set({ scenePurgedAt: now, sceneKey: null, sceneBaseKey: null, sceneMaskKey: null })
          .where(inArray(photoCompositions.id, e.scenes));
      if (e.sets.length)
        await tx
          .update(photoSets)
          .set({ zipStatus: "none", zipKey: null, zipBytes: null, zipFingerprint: null })
          .where(and(inArray(photoSets.id, e.sets), eq(photoSets.zipStatus, "ready")));
    });
  }
  return { scenes: scenes.length, zips: zips.length, objects };
}
