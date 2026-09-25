import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { itemArtwork, orderItems, outboxEvents } from "../../db/schema";
import { ImagingError } from "../../integrations/imaging/client";
import { runJobInline } from "../../lib/queues";
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
import { createTemplate } from "./service";

/*
 * T-3-4 (B-61, B-12): mapping a personalized item only queues its render; the render job runs
 * after commit, retries transient imaging failures (3 attempts) and on the last one flags the
 * unit `needs_artwork` with the reason.
 */

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

let companyId: string;
let ctx: ReturnType<typeof tenantContext>;
let connectionId: string;
let designId: string;
let blankId: string;

beforeAll(async () => {
  companyId = (await createCompany()).id;
  const owner = await createUser(companyId, "owner");
  ctx = tenantContext(companyId, owner.id, "owner");
  await createLocation(companyId);
  connectionId = (await createConnection(companyId, "etsy")).id;
  await withTenant(companyId, async (tx) => {
    await bulkImportBlanks(tx, ctx, {
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
    const template = await createTemplate(tx, ctx, {
      name: "Name tee",
      widthIn: 11,
      heightIn: 12,
      backgroundKey: null,
      dpi: 300,
      slots: [
        {
          name: "name",
          kind: "text",
          xIn: 0.5,
          yIn: 8,
          wIn: 10,
          hIn: 1.6,
          fontFamily: "Inter Bold",
          fontSizePt: 48,
          color: "#1a1a1a",
          align: "center",
          maxChars: 16,
          uppercase: true,
          sourceQuestion: "name",
          required: true,
          placeholder: null,
        },
      ],
    });
    designId = (
      await createDesign(tx, ctx, {
        code: "P001",
        name: "Name tee",
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: `${companyId}/design/p001.png`,
            widthIn: 11,
            heightIn: 12,
          },
        ],
        personalizationTemplateId: template.id,
      })
    ).id;
  });
  const { blankVariants } = await import("../../db/schema");
  const [b] = await withTenant(companyId, (tx) => tx.select().from(blankVariants));
  blankId = b?.id as string;
});

beforeEach(() => {
  render.fn.mockClear();
});

/** A personalized unit, mapped in one transaction the way an import does it. */
async function mappedItem(name = "Ana") {
  const { items } = await createOrder(companyId, connectionId, { units: 1, state: "imported" });
  const itemId = items[0]?.id as string;
  await withSystem((tx) =>
    tx
      .update(orderItems)
      .set({ personalization: [{ question: "Name", answer: name, fileUrl: null }] })
      .where(eq(orderItems.id, itemId)),
  );
  await withTenant(companyId, (tx) =>
    mapItems(tx, ctx, [itemId], { designId, blankVariantId: blankId, ruleId: null, via: "rule" }),
  );
  return itemId;
}

const itemRow = async (id: string) => {
  const [row] = await withSystem((tx) => tx.select().from(orderItems).where(eq(orderItems.id, id)));
  return row;
};
const artworkRow = async (id: string) => {
  const [row] = await withSystem((tx) =>
    tx.select().from(itemArtwork).where(eq(itemArtwork.orderItemId, id)),
  );
  return row;
};

describe("personalization render job", () => {
  it("mapping queues the render in its transaction; the job renders once", async () => {
    const itemId = await mappedItem();
    expect(render.fn).not.toHaveBeenCalled();
    expect(await itemRow(itemId)).toMatchObject({ state: "ready", artworkStatus: "pending" });
    expect(await artworkRow(itemId)).toMatchObject({ status: "pending", values: { name: "Ana" } });
    const events = await withSystem((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.name, "artwork.render_requested")),
    );
    expect(events.some((e) => (e.payload.orderItemIds as string[]).includes(itemId))).toBe(true);

    await runJobInline(renderArtworkJob, { companyId, orderItemIds: [itemId] });
    expect(render.fn).toHaveBeenCalledTimes(1);
    expect(await itemRow(itemId)).toMatchObject({ state: "ready", artworkStatus: "rendered" });
    expect((await artworkRow(itemId))?.status).toBe("rendered");

    // A duplicate event or retry renders nothing again.
    await runJobInline(renderArtworkJob, { companyId, orderItemIds: [itemId] });
    expect(render.fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient imaging failure, then succeeds on the next attempt", async () => {
    const itemId = await mappedItem();
    render.fn.mockRejectedValueOnce(new ImagingError("/render/personalization", 503, "busy"));
    await expect(
      runJobInline(
        renderArtworkJob,
        { companyId, orderItemIds: [itemId] },
        { attempt: 1, attempts: 3 },
      ),
    ).rejects.toThrow(/retrying/);
    // Nothing was saved: still pending, the unit untouched.
    expect(await itemRow(itemId)).toMatchObject({ state: "ready", artworkStatus: "pending" });
    await runJobInline(
      renderArtworkJob,
      { companyId, orderItemIds: [itemId] },
      { attempt: 2, attempts: 3 },
    );
    expect(await itemRow(itemId)).toMatchObject({ state: "ready", artworkStatus: "rendered" });
  });

  it("on the last attempt flags the unit needs_artwork with the reason", async () => {
    const itemId = await mappedItem();
    render.fn.mockRejectedValue(new ImagingError("/render/personalization", 503, "imaging down"));
    for (const attempt of [1, 2])
      await expect(
        runJobInline(
          renderArtworkJob,
          { companyId, orderItemIds: [itemId] },
          { attempt, attempts: 3 },
        ),
      ).rejects.toThrow(/retrying/);
    await runJobInline(
      renderArtworkJob,
      { companyId, orderItemIds: [itemId] },
      { attempt: 3, attempts: 3 },
    );
    render.fn.mockReset();
    render.fn.mockImplementation(async (input: { out_key: string }) => ({
      key: input.out_key,
      width_px: 3300,
      height_px: 3600,
      flags: [],
    }));
    const item = await itemRow(itemId);
    expect(item).toMatchObject({ state: "needs_artwork", artworkStatus: "failed" });
    expect(item?.flags).toContainEqual(
      expect.objectContaining({
        code: "artwork_qa_failed",
        message: "Personalization render failed: imaging down",
      }),
    );
    expect(await artworkRow(itemId)).toMatchObject({ status: "failed", error: "imaging down" });
  });

  it("a refused render (4xx) is saved at once, without retrying", async () => {
    const itemId = await mappedItem();
    render.fn.mockRejectedValueOnce(new ImagingError("/render/personalization", 422, "bad font"));
    await runJobInline(
      renderArtworkJob,
      { companyId, orderItemIds: [itemId] },
      { attempt: 1, attempts: 3 },
    );
    expect(await itemRow(itemId)).toMatchObject({
      state: "needs_artwork",
      artworkStatus: "failed",
    });
  });

  it("a staff edit made while the render was queued wins; the job skips the item", async () => {
    const itemId = await mappedItem();
    await withSystem((tx) =>
      tx.update(itemArtwork).set({ status: "approved" }).where(eq(itemArtwork.orderItemId, itemId)),
    );
    await runJobInline(renderArtworkJob, { companyId, orderItemIds: [itemId] });
    expect(render.fn).not.toHaveBeenCalled();
  });
});
