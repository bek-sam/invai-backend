import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { getImageProvider, IMAGE_JOB_KIND, SCENE_PROMPT_REF } from "../../src/ai/images";
import { imageCostCents, OPENAI_IMAGE_MODEL } from "../../src/ai/models";
import { withSystem, withTenant } from "../../src/db/client";
import {
  aiJobs,
  designs,
  members,
  photoCompositions,
  photoImages,
  users,
} from "../../src/db/schema";
import { imaging } from "../../src/integrations/imaging/client";
import { renderCompositionJob, renderSceneJob } from "../../src/modules/photos/jobs";
import * as svc from "../../src/modules/photos/service";
import { runJobInline } from "../../src/lib/queues";
import { tenantContext } from "../../src/test/fixtures";
import { CONTROL_PROMPT_REF, controlGate, runControl } from "./control";
import { copyKeys, maskStats } from "./frames";
import { budgetVerdict, ledgerCents } from "./guard";
import { getObject } from "../../src/lib/s3";

/*
 * Scene trial runner (T-37-2 AC3, AC4). Creates one photo set with lifestyle scenes for a named
 * design and blank color through the photos service, runs the scene jobs in process, and prints
 * one line per scene plus totals and the cost from ai_jobs.
 *
 *   tsx evals/scene_trial/run.ts --design "Good Vibes Only Agave" --color white [--scenes 6] [--yes-paid]
 *   tsx evals/scene_trial/run.ts --design "Good Vibes Only Agave" --color white --control [--yes-paid]
 *
 * --control (T-38-2 AC4) makes one provider call with a fresh scene base and a fixed prompt that
 * asks to change nothing, then prints registration, check 1 and lock scores. It counts in the
 * ledger and the daily cap, creates no photo set, image row or credit charge.
 * SCENE_TRIAL_IMAGING_SHA (optional) is printed so a run is tied to the imaging build (the mask).
 *
 * Free with the mock provider. A real provider needs the process environment to carry
 * IMAGE_GEN_PROVIDER=openai, the --yes-paid flag, and a ledger under the budget:
 *   SCENE_TRIAL_SINCE (default 2026-10-12T00:00:00Z), SCENE_TRIAL_BUDGET_CENTS (default 600).
 * Judges frames by metrics only; it never opens an image.
 */

const COLORS = {
  white: { name: "White", hex: "#ffffff" },
  black: { name: "Black", hex: "#000000" },
} as const;
const OWNER_EMAIL = "owner@desertbloom.test";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(msg: string): never {
  console.error(`scene_trial: ${msg}`);
  process.exit(2);
}

type Composite = Awaited<ReturnType<typeof imaging.photoSceneComposite>>;

async function main() {
  const designName = arg("design") ?? fail("--design <name> is required");
  const colorKey = (arg("color") ?? fail("--color white|black is required")) as keyof typeof COLORS;
  const color = COLORS[colorKey] ?? fail("--color must be white or black");
  const control = flag("control");
  const scenes = control ? 0 : Number(arg("scenes") ?? 6);
  if (!control && (!Number.isInteger(scenes) || scenes < 1 || scenes > 6))
    fail("--scenes must be 1..6");

  const since = new Date(process.env.SCENE_TRIAL_SINCE ?? "2026-10-12T00:00:00Z");
  const budget = Number(process.env.SCENE_TRIAL_BUDGET_CENTS ?? 600);
  if (Number.isNaN(since.getTime()) || !Number.isFinite(budget))
    fail("SCENE_TRIAL_SINCE or SCENE_TRIAL_BUDGET_CENTS is not valid");

  // The owner's company and the design.
  const [owner] = await withSystem((tx) =>
    tx
      .select({ userId: users.id, companyId: members.organizationId })
      .from(users)
      .innerJoin(members, eq(members.userId, users.id))
      .where(eq(users.email, OWNER_EMAIL))
      .limit(1),
  );
  if (!owner) fail(`no ${OWNER_EMAIL}: seed the dev DB first`);
  const [design] = await withTenant(owner.companyId, (tx) =>
    tx.select({ id: designs.id }).from(designs).where(eq(designs.name, designName)).limit(1),
  );
  if (!design) fail(`no design named "${designName}"`);

  // Provider and paid guards, before any call.
  const provider = await getImageProvider(owner.companyId);
  const paid = provider.name !== "mock";
  const requestedOpenAi = process.env.IMAGE_GEN_PROVIDER === "openai";
  const perImage = imageCostCents(OPENAI_IMAGE_MODEL, "1024x1024");
  // A trial retries a scene once at worst; the control is one call with no retry.
  const worstCase = control ? perImage : scenes * 2 * perImage;
  const ledger = await ledgerCents(since);
  if (paid || requestedOpenAi) {
    if (!requestedOpenAi) fail("refused: IMAGE_GEN_PROVIDER=openai is not set in the process environment");
    if (!flag("yes-paid")) fail("refused: a paid run needs --yes-paid");
    if (!paid)
      fail(`refused: openai was requested but the provider resolved to ${provider.name} (missing key or sample workspace)`);
    const v = budgetVerdict({ ledger, worstCase, budget });
    if (!v.ok) fail(`refused before any call: ${v.reason}`);
    console.log(`budget ok: ${v.reason}`);
  }
  console.log(
    `provider ${provider.name}/${provider.model}, prompt ${control ? CONTROL_PROMPT_REF : SCENE_PROMPT_REF}, design "${designName}", blank ${color.name}, ${control ? "control call" : `scenes ${scenes}`}, worst case ${worstCase}c, imaging sha ${process.env.SCENE_TRIAL_IMAGING_SHA ?? "unset"}`,
  );

  if (control) {
    const { front } = await withTenant(owner.companyId, (tx) =>
      svc.printFile(tx, tenantContext(owner.companyId, owner.userId, "owner"), design.id),
    );
    if (!front) fail(`design "${designName}" has no front print file`);
    const r = await runControl({
      companyId: owner.companyId,
      userId: owner.userId,
      provider,
      design: front,
      colorHex: color.hex,
    });
    const f = (n: number | null) => (n == null ? "-" : n.toFixed(3));
    const g = controlGate(r.scores);
    console.log(
      `control: ${r.scores.passes ? "PASS" : "FAIL"} | codes ${r.scores.failures.join(",") || "-"} | reasons ${r.scores.regionReasons.join(",") || "-"} | structural ${r.scores.structural} | reg ${f(r.scores.registration)} | c1 ${f(r.scores.c1)} | lock ${f(r.scores.lock)}`,
    );
    console.log(`control keys: base ${r.keys.base} mask ${r.keys.mask} scene ${r.keys.scene}`);
    const cm = maskStats(await getObject(r.keys.mask));
    console.log(`control mask: alpha255 share ${cm.alpha255Share.toFixed(4)} hash ${cm.hash}`);
    const out = arg("out");
    if (out) {
      await copyKeys(out, [r.keys.base, r.keys.mask, r.keys.scene]);
      await writeFile(join(out, `design-${design.id.slice(0, 8)}.png`), await getObject(front.fileKey));
      console.log(`copied control files to ${out}`);
    }
    console.log(`control gate: ${g.reason}`);
    console.log(
      `cost: ${r.cents}c for 1 image_scene ai_job ${r.aiJobId}; ledger since ${since.toISOString()} now ${await ledgerCents(since)}c of ${budget}c`,
    );
    return;
  }

  // Capture the full imaging result of every composite (the DB keeps only part of it).
  const seen = new Map<string, Composite[]>();
  const realComposite = imaging.photoSceneComposite;
  imaging.photoSceneComposite = async (input) => {
    const res = await realComposite(input);
    const m = /scenes\/([0-9a-f-]{36})-a\d+\.png$/.exec(input.scene_key);
    if (m?.[1]) seen.set(m[1], [...(seen.get(m[1]) ?? []), res]);
    return res;
  };

  const ctx = tenantContext(owner.companyId, owner.userId, "owner");
  const set = await withTenant(owner.companyId, (tx) =>
    svc.createSet(tx, ctx, {
      designId: design.id,
      garments: ["tee"],
      colors: [color],
      views: ["front_flat"],
      channels: ["shopify", "etsy"],
      underbasePreview: true,
      lifestyle: { count: scenes },
      idempotencyKey: `scene-trial-${crypto.randomUUID()}`,
    }),
  );
  console.log(`set ${set.id}`);

  // Every trial composition is new (A10): ensureBase reuses a stored base and mask, so a stored
  // key here would send an old mask. The set was just created; assert it.
  const fresh = await withTenant(owner.companyId, (tx) =>
    tx
      .select({ id: photoCompositions.id, base: photoCompositions.sceneBaseKey })
      .from(photoCompositions)
      .where(eq(photoCompositions.setId, set.id)),
  );
  if (fresh.some((c) => c.base !== null)) fail("a trial composition already has a stored scene base");
  console.log(`fresh compositions: ${fresh.length}, none with a stored scene base`);

  for (const c of await svc.openCompositionsBySource(owner.companyId, set.id)) {
    if (c.source === "ai_scene")
      await runJobInline(renderSceneJob, { companyId: owner.companyId, compositionId: c.id });
    else await runJobInline(renderCompositionJob, { companyId: owner.companyId, compositionId: c.id });
  }

  const comps = await withTenant(owner.companyId, (tx) =>
    tx
      .select()
      .from(photoCompositions)
      .where(and(eq(photoCompositions.setId, set.id), eq(photoCompositions.source, "ai_scene"))),
  );
  const ids = comps.map((c) => c.id);
  const images = ids.length
    ? await withTenant(owner.companyId, (tx) =>
        tx.select().from(photoImages).where(inArray(photoImages.compositionId, ids)),
      )
    : [];
  const jobs = ids.length
    ? await withSystem((tx) =>
        tx
          .select({ entityId: aiJobs.entityId, cents: aiJobs.costCents })
          .from(aiJobs)
          .where(and(eq(aiJobs.kind, IMAGE_JOB_KIND), inArray(aiJobs.entityId, ids))),
      )
    : [];

  console.log(
    "kind | attempts | calls | pass | codes | region_reasons | structural | c1 | lock | reg per frame | structural_skips",
  );
  let scenesPassed = 0;
  let framesPassed = 0;
  let framesTotal = 0;
  let calls = 0;
  let skips = 0;
  const regs: number[] = [];
  for (const c of comps) {
    const imgs = images.filter((i) => i.compositionId === c.id);
    const nCalls = jobs.filter((j) => j.entityId === c.id).length;
    const composites = seen.get(c.id) ?? [];
    const last = composites.at(-1);
    const ok = imgs.length > 0 && imgs.every((i) => i.status === "rendered");
    const framesOk = imgs.filter((i) => i.status === "rendered").length;
    const codes = [...new Set(imgs.flatMap((i) => (i.checks?.failures ?? []).map((f) => f.code)))].join(",") || "-";
    const reasons = [...new Set(composites.flatMap((r) => r.checks.region_reasons ?? []))].join(",") || "-";
    const structural = composites.length > 0 && composites.every((r) => r.checks.structural === true);
    const sceneRegs = composites
      .map((r) => r.registration?.score)
      .filter((n): n is number => typeof n === "number");
    regs.push(...sceneRegs);
    const skipped = structural && nCalls === 1 && !ok ? 1 : 0;
    scenesPassed += ok ? 1 : 0;
    framesPassed += framesOk;
    framesTotal += imgs.length;
    calls += nCalls;
    skips += skipped;
    const f = (n: number | null | undefined) => (n == null ? "-" : n.toFixed(3));
    console.log(
      [
        c.sceneKind,
        Math.max(1, c.sceneAttempt),
        nCalls,
        ok ? "PASS" : "FAIL",
        codes,
        reasons,
        structural,
        f(last?.checks.region_unchanged_score),
        f(last?.checks.design_lock_score),
        sceneRegs.length ? sceneRegs.map((n) => n.toFixed(3)).join("/") : "-",
        skipped,
      ].join(" | "),
    );
  }
  const sorted = [...regs].sort((a, b) => a - b);
  const mid = sorted.length
    ? sorted.length % 2
      ? (sorted[(sorted.length - 1) / 2] as number)
      : ((sorted[sorted.length / 2 - 1] as number) + (sorted[sorted.length / 2] as number)) / 2
    : null;
  console.log(
    `registration over ${sorted.length} frames: min ${sorted[0]?.toFixed(3) ?? "-"} median ${mid?.toFixed(3) ?? "-"} max ${sorted.at(-1)?.toFixed(3) ?? "-"}`,
  );
  const out = arg("out");
  for (const c of comps) {
    if (!c.sceneMaskKey) continue;
    const m = maskStats(await getObject(c.sceneMaskKey));
    console.log(`mask ${c.sceneKind} ${c.id.slice(0, 8)}: alpha255 share ${m.alpha255Share.toFixed(4)} hash ${m.hash}`);
    if (out) {
      const keys = [c.sceneBaseKey, c.sceneMaskKey];
      for (let a = 1; a <= Math.max(1, c.sceneAttempt); a++)
        keys.push(`${owner.companyId}/photos/${set.id}/scenes/${c.id}-a${a}.png`);
      await copyKeys(out, keys.filter((k): k is string => !!k));
    }
  }
  if (out) {
    const { front } = await withTenant(owner.companyId, (tx) => svc.printFile(tx, ctx, design.id));
    if (front) await writeFile(join(out, `design-${design.id.slice(0, 8)}.png`), await getObject(front.fileKey));
    console.log(`copied frame files to ${out}; set id ${set.id}`);
  }
  const cents = jobs.reduce((n, j) => n + j.cents, 0);
  console.log(
    `totals: scenes ${scenesPassed}/${comps.length}, frames ${framesPassed}/${framesTotal}, provider calls ${calls}, structural skips ${skips}`,
  );
  console.log(
    `cost: sum(cost_cents) ${cents}c over count(*) ${jobs.length} image_scene ai_jobs for this set; ledger since ${since.toISOString()} now ${await ledgerCents(since)}c of ${budget}c`,
  );
  imaging.photoSceneComposite = realComposite;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(async () => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
