import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  itemArtwork,
  orderItems,
  personalizationTemplates,
  type TemplateSlot,
} from "../../db/schema";
import { runJobInline } from "../../lib/queues";
import { objectKey } from "../../lib/s3";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { bulkImportBlanks, createDesign } from "../catalog/service";
import { mapItems } from "../orders/mapping";
import { renderArtworkJob } from "./jobs";
import {
  createTemplate,
  getArtwork,
  previewTemplate,
  renderValues,
  rerenderArtwork,
  updateArtworkValues,
} from "./service";

/*
 * T-31-1 (S-60): imaging downloads every photo-slot value as a storage key, so no value that is
 * not a key of the render's own company may reach it. Staff input is refused (NOT_FOUND); buyer
 * answers and stored values are dropped and flagged `missing_answer`.
 */

type RenderInput = { out_key: string; values: Record<string, string>; template: unknown };
const render = vi.hoisted(() => ({
  fn: vi.fn(async (input: { out_key: string }) => ({
    key: input.out_key,
    width_px: 3300,
    height_px: 3600,
    flags: [] as { slot: string; code: "overflow"; message: string }[],
  })),
}));

vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return { ...actual, imaging: { ...actual.imaging, renderPersonalization: render.fn } };
});

const sentValues = () => {
  const call = render.fn.mock.calls.at(-1);
  if (!call) throw new Error("imaging was not called");
  return (call[0] as unknown as RenderInput).values;
};

let shopA: string;
let shopB: string;
let office: ReturnType<typeof tenantContext>;
let connectionId: string;
let blankId: string;
const templates: Record<"required" | "optional", string> = { required: "", optional: "" };
const designs: Record<"required" | "optional", string> = { required: "", optional: "" };

const slot = (name: string, kind: "text" | "photo", required: boolean, yIn: number) =>
  ({
    name,
    kind,
    xIn: 0.5,
    yIn,
    wIn: 10,
    hIn: 3,
    fontFamily: "Inter Bold",
    fontSizePt: 48,
    minFontSizePt: null,
    maxLines: null,
    strokeWidthPt: 0,
    strokeColor: null,
    fit: "fit",
    color: "#1a1a1a",
    align: "center",
    maxChars: null,
    uppercase: false,
    sourceQuestion: name,
    required,
    placeholder: null,
  }) as TemplateSlot;

const ownKey = () => `${shopB}/upload/2026/10/${crypto.randomUUID()}.png`;
const foreignValues = () => [
  `${shopA}/upload/2026/10/${crypto.randomUUID()}.png`,
  "../x.png",
  "https://evil.example/x.png",
  "/x.png",
];

beforeAll(async () => {
  shopA = (await createCompany()).id;
  shopB = (await createCompany()).id;
  const owner = tenantContext(shopB, (await createUser(shopB, "owner")).id, "owner");
  office = tenantContext(shopB, (await createUser(shopB, "office")).id, "office");
  await createLocation(shopB);
  connectionId = (await createConnection(shopB, "etsy")).id;
  await withTenant(shopB, async (tx) => {
    await bulkImportBlanks(tx, owner, {
      rows: [
        {
          brand: "Gildan",
          style: "64000",
          styleCode: "G64000",
          styleName: null,
          color: "Black",
          colorCode: "BLK",
          colorHex: null,
          size: "M",
          sizeCode: "M",
          supplier: "ssactivewear" as const,
          supplierSku: "BBLKM",
          cost: 289,
          weightOz: 5.3,
        },
      ],
    });
    for (const kind of ["required", "optional"] as const) {
      const t = await createTemplate(tx, owner, {
        name: `Photo tee ${kind}`,
        widthIn: 11,
        heightIn: 12,
        backgroundKey: null,
        dpi: 300,
        slots: [slot("name", "text", true, 0.5), slot("photo", "photo", kind === "required", 5)],
      });
      templates[kind] = t.id;
      designs[kind] = (
        await createDesign(tx, owner, {
          code: `PH-${kind}`,
          name: `Photo tee ${kind}`,
          tags: [],
          placements: [
            { placement: "front", fileKey: `${shopB}/design/ph.png`, widthIn: 11, heightIn: 12 },
          ],
          personalizationTemplateId: t.id,
        })
      ).id;
    }
  });
  const { blankVariants } = await import("../../db/schema");
  const [b] = await withTenant(shopB, (tx) => tx.select().from(blankVariants));
  blankId = b?.id as string;
});

beforeEach(() => {
  render.fn.mockClear();
});

/** A unit of shop B with the buyer's answers, mapped and rendered by the job as an import does. */
async function renderedItem(photo: string, kind: "required" | "optional" = "required") {
  const { items } = await createOrder(shopB, connectionId, { units: 1, state: "imported" });
  const itemId = items[0]?.id as string;
  await withSystem((tx) =>
    tx
      .update(orderItems)
      .set({
        personalization: [
          { question: "Name", answer: "Ana", fileUrl: null },
          { question: "Photo", answer: photo, fileUrl: null },
        ],
      })
      .where(eq(orderItems.id, itemId)),
  );
  await withTenant(shopB, (tx) =>
    mapItems(tx, office, [itemId], {
      designId: designs[kind],
      blankVariantId: blankId,
      ruleId: null,
      via: "rule",
    }),
  );
  await runJobInline(renderArtworkJob, { companyId: shopB, orderItemIds: [itemId] });
  return itemId;
}

const itemRow = async (id: string) =>
  (await withSystem((tx) => tx.select().from(orderItems).where(eq(orderItems.id, id))))[0];
const artworkRow = async (id: string) =>
  (
    await withSystem((tx) => tx.select().from(itemArtwork).where(eq(itemArtwork.orderItemId, id)))
  )[0];

describe("photo-slot values reach imaging only as the shop's own keys (S-60)", () => {
  it("previewTemplate refuses another shop's key or a malformed key with NOT_FOUND", async () => {
    for (const photo of foreignValues()) {
      await expect(
        withTenant(shopB, (tx) =>
          previewTemplate(tx, office, { id: templates.required, values: { name: "Ana", photo } }),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(render.fn).not.toHaveBeenCalled();

    // AC5: an own key still renders, sent as is.
    const own = ownKey();
    const out = await withTenant(shopB, (tx) =>
      previewTemplate(tx, office, { id: templates.required, values: { name: "Ana", photo: own } }),
    );
    expect(out.flags).toEqual([]);
    expect(sentValues()).toEqual({ name: "Ana", photo: own });
  });

  it("updateArtworkValues refuses another shop's key; nothing is stored, imaging not called", async () => {
    const own = ownKey();
    const itemId = await renderedItem(own);
    const before = await artworkRow(itemId);
    expect(before).toMatchObject({ status: "rendered", values: { name: "Ana", photo: own } });
    render.fn.mockClear();
    for (const photo of foreignValues()) {
      for (const approve of [false, true])
        await expect(
          withTenant(shopB, (tx) =>
            updateArtworkValues(tx, office, { orderItemId: itemId, values: { photo }, approve }),
          ),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(render.fn).not.toHaveBeenCalled();
    const after = await artworkRow(itemId);
    expect(after?.values).toEqual(before?.values);
    expect(after?.fileKey).toBe(before?.fileKey);

    // Another shop can't reach the item at all.
    const officeA = tenantContext(shopA, (await createUser(shopA, "office")).id, "office");
    await expect(
      withTenant(shopA, (tx) =>
        updateArtworkValues(tx, officeA, {
          orderItemId: itemId,
          values: { photo: own },
          approve: false,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  for (const kind of ["required", "optional"] as const)
    it(`buyer answers that aren't own keys are dropped and flagged once (${kind} slot)`, async () => {
      for (const photo of [...foreignValues(), "my dog Rex"]) {
        const before = render.fn.mock.calls.length;
        const itemId = await renderedItem(photo, kind);
        expect(render.fn.mock.calls.length).toBe(before + 1);
        expect(sentValues()).toEqual({ name: "Ana" });
        const a = await artworkRow(itemId);
        expect(a?.status).toBe("flagged");
        const photoFlags = (a?.flags ?? []).filter((f) => f.slot === "photo");
        expect(photoFlags).toEqual([
          {
            slot: "photo",
            code: "missing_answer",
            message:
              'Add the buyer\'s photo for "photo". The answer was not a photo uploaded to this shop.',
            suggestion: null,
          },
        ]);
        expect(await itemRow(itemId)).toMatchObject({
          state: "needs_artwork",
          artworkStatus: "flagged",
        });
        // A second run (retry, duplicate event) changes nothing and does not throw.
        await runJobInline(renderArtworkJob, { companyId: shopB, orderItemIds: [itemId] });
        expect(render.fn.mock.calls.length).toBe(before + 1);
      }
    });

  it("a stored foreign photo is dropped on re-render and approve:true does not approve", async () => {
    const itemId = await renderedItem(ownKey());
    const foreign = `${shopA}/upload/2026/10/${crypto.randomUUID()}.png`;
    await withSystem((tx) =>
      tx
        .update(itemArtwork)
        .set({ values: { name: "Ana", photo: foreign } })
        .where(eq(itemArtwork.orderItemId, itemId)),
    );
    render.fn.mockClear();
    const out = await withTenant(shopB, (tx) =>
      updateArtworkValues(tx, office, {
        orderItemId: itemId,
        values: { name: "Bo" },
        approve: true,
      }),
    );
    expect(sentValues()).toEqual({ name: "Bo" });
    expect(out.status).toBe("flagged");
    expect(out.approvedAt).toBeNull();
    expect(out.flags).toContainEqual(
      expect.objectContaining({ slot: "photo", code: "missing_answer" }),
    );
    expect(await itemRow(itemId)).toMatchObject({
      state: "needs_artwork",
      artworkStatus: "flagged",
    });

    render.fn.mockClear();
    await withTenant(shopB, (tx) => rerenderArtwork(tx, office, itemId));
    expect(sentValues()).toEqual({ name: "Bo" });
    const again = await withTenant(shopB, (tx) => getArtwork(tx, office, itemId));
    expect(again.flags.filter((f) => f.slot === "photo")).toHaveLength(1);
  });

  it("a foreign template background fails the render and never reaches imaging", async () => {
    const itemId = await renderedItem(ownKey());
    const [t] = await withSystem((tx) =>
      tx
        .insert(personalizationTemplates)
        .values({
          companyId: shopB,
          name: "Legacy background",
          widthIn: 11,
          heightIn: 12,
          backgroundKey: `${shopA}/template_background/x.png`,
          dpi: 300,
          slots: [slot("name", "text", true, 0.5), slot("photo", "photo", true, 5)],
        })
        .returning(),
    );
    const templateId = t?.id as string;
    render.fn.mockClear();
    await expect(
      withTenant(shopB, (tx) =>
        previewTemplate(tx, office, { id: templateId, values: { name: "Ana" } }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await withSystem((tx) =>
      tx.update(itemArtwork).set({ templateId }).where(eq(itemArtwork.orderItemId, itemId)),
    );
    const out = await withTenant(shopB, (tx) => rerenderArtwork(tx, office, itemId));
    expect(render.fn).not.toHaveBeenCalled();
    expect(out.status).toBe("failed");
    expect(await itemRow(itemId)).toMatchObject({
      state: "needs_artwork",
      artworkStatus: "failed",
    });
  });

  it("renderValues (the seed's call) checks photo values against the out key's company", async () => {
    const template = {
      widthIn: 11,
      heightIn: 12,
      backgroundKey: null,
      dpi: 300,
      slots: [slot("name", "text", true, 0.5), slot("photo", "photo", false, 5)],
    };
    const own = ownKey();
    const ok = await renderValues(
      template,
      { name: "Ana", photo: own },
      objectKey(shopB, "artwork", "png"),
    );
    expect(ok).toMatchObject({ status: "rendered", droppedPhotoSlots: [] });
    expect(sentValues()).toEqual({ name: "Ana", photo: own });

    const foreign = await renderValues(
      template,
      { name: "Ana", photo: `${shopA}/upload/x.png` },
      objectKey(shopB, "artwork", "png"),
    );
    expect(foreign).toMatchObject({ status: "flagged", droppedPhotoSlots: ["photo"] });
    expect(sentValues()).toEqual({ name: "Ana" });

    // Fail closed: no company in the out key means no photo value is sent, own-looking or not.
    for (const outKey of [`../${shopB}/artwork/x.png`, "artwork/x.png", `not-a-uuid/x.png`]) {
      const out = await renderValues(template, { name: "Ana", photo: own }, outKey);
      expect(out.droppedPhotoSlots).toEqual(["photo"]);
      expect(sentValues()).toEqual({ name: "Ana" });
    }
    // Whitespace is no answer: not sent, and an optional slot is not flagged.
    const blank = await renderValues(
      template,
      { name: "Ana", photo: "  " },
      objectKey(shopB, "artwork", "png"),
    );
    expect(blank).toMatchObject({ status: "rendered", droppedPhotoSlots: [] });
    expect(sentValues()).toEqual({ name: "Ana" });
  });
});
