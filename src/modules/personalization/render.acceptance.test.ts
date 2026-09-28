import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { itemArtwork, orderItems, outboxEvents } from "../../db/schema";
import * as outbox from "../../lib/outbox";
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
import { createTemplate, renderItemArtwork } from "./service";

/*
 * T-20-3 (B-71) AC2, renderItemArtwork / the render job: imaging is called with no transaction
 * open, so a commit failure after the render leaves the artwork `pending` and untouched; the
 * retry renders again (imaging is repeatable and charges nothing) and saves once. Two runs of
 * the same render at once save one row and emit one `artwork.rendered`. The interactive
 * re-render stores one artwork row per item however often it runs.
 */

const render = vi.hoisted(() => ({
  calls: 0,
  gate: null as (() => Promise<void>) | null,
  fn: vi.fn(async (input: { out_key: string }) => {
    render.calls += 1;
    await render.gate?.();
    return {
      key: input.out_key,
      width_px: 3300,
      height_px: 3600,
      flags: [] as { slot: string; code: "overflow"; message: string }[],
    };
  }),
}));

vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return { ...actual, imaging: { ...actual.imaging, renderPersonalization: render.fn } };
});
vi.mock("../../lib/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/outbox")>();
  return { ...actual, emit: vi.fn(actual.emit) };
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
          supplierSku: "T203BLKM",
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
          minFontSizePt: null,
          maxLines: null,
          strokeWidthPt: 0,
          strokeColor: null,
          fit: "fit",
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
        code: "P203",
        name: "Name tee",
        tags: [],
        placements: [
          {
            placement: "front",
            fileKey: `${companyId}/design/p203.png`,
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
  render.calls = 0;
  render.gate = null;
  vi.mocked(outbox.emit).mockClear();
});

/** A personalized unit, mapped the way an import does it (render queued, not run). */
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
const artworkRows = (id: string) =>
  withSystem((tx) => tx.select().from(itemArtwork).where(eq(itemArtwork.orderItemId, id)));
const renderedEvents = async (id: string) =>
  (
    await withSystem((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.name, "artwork.rendered")),
    )
  ).filter((e) => e.payload.orderItemId === id);

describe("T-20-3 personalization render side effects", () => {
  it("a commit failure after imaging rendered leaves the artwork pending; the retry saves once", async () => {
    const itemId = await mappedItem();
    vi.mocked(outbox.emit).mockImplementationOnce(async () => {
      throw new Error("simulated commit failure");
    });
    await expect(
      runJobInline(renderArtworkJob, { companyId, orderItemIds: [itemId] }),
    ).rejects.toThrow(/simulated commit failure/);
    expect(render.calls).toBe(1);
    // Nothing half-saved: still the queued render, the unit untouched.
    expect(await artworkRows(itemId)).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(await itemRow(itemId)).toMatchObject({ state: "ready", artworkStatus: "pending" });

    await runJobInline(renderArtworkJob, { companyId, orderItemIds: [itemId] });
    expect(render.calls).toBe(2);
    const rows = await artworkRows(itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "rendered", values: { name: "Ana" } });
    expect(await itemRow(itemId)).toMatchObject({ state: "ready", artworkStatus: "rendered" });
    expect(await renderedEvents(itemId)).toHaveLength(1);
  });

  it("two concurrent runs of the same render save one row and emit one artwork.rendered", async () => {
    const itemId = await mappedItem("Luis");
    let waiting = 0;
    let open: () => void = () => {};
    const opened = new Promise<void>((r) => {
      open = r;
    });
    render.gate = async () => {
      waiting += 1;
      if (waiting >= 2) open();
      await opened;
    };
    const outcomes = await Promise.all([
      runJobInline(renderArtworkJob, { companyId, orderItemIds: [itemId] }),
      runJobInline(renderArtworkJob, { companyId, orderItemIds: [itemId] }),
    ]);
    expect(outcomes).toHaveLength(2);
    expect(render.calls).toBe(2);
    const rows = await artworkRows(itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("rendered");
    expect(await renderedEvents(itemId)).toHaveLength(1);
    expect(await itemRow(itemId)).toMatchObject({ state: "ready", artworkStatus: "rendered" });
  });

  it("the interactive re-render keeps one artwork row per item across repeats", async () => {
    const itemId = await mappedItem("Sofía");
    await runJobInline(renderArtworkJob, { companyId, orderItemIds: [itemId] });
    const first = (await artworkRows(itemId))[0];
    const a = await withTenant(companyId, (tx) =>
      renderItemArtwork(tx, ctx, itemId, { values: { name: "SOFÍA" } }),
    );
    const b = await withTenant(companyId, (tx) =>
      renderItemArtwork(tx, ctx, itemId, { values: { name: "SOFÍA" } }),
    );
    expect(a.clean && b.clean).toBe(true);
    const rows = await artworkRows(itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first?.id, status: "rendered", values: { name: "SOFÍA" } });
    expect(render.calls).toBe(3);
  });
});
