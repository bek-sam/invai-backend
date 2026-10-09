import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { itemArtwork, orderItems } from "../../db/schema";
import { headObject, putObject } from "../../lib/s3";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { createNameTemplate } from "../privacy/buyer-text.fixtures";
import { redactBuyerText } from "../privacy/service";
import { approveArtwork, renderItemArtwork, rerenderArtwork, updateArtworkValues } from "./service";

/*
 * T-29-1 (decision 0027): a re-render deletes the render it replaces; a purged artwork can't be
 * approved (CONFLICT), and new values (a re-render) are the way back in.
 */

/* Imaging is mocked; the render is written to MinIO so its deletion can be checked. */
const render = vi.hoisted(() => ({
  fn: vi.fn(async (input: { out_key: string }) => {
    const { putObject: put } = await import("../../lib/s3");
    await put(input.out_key, "png", "image/png");
    return { key: input.out_key, width_px: 3000, height_px: 3600, flags: [] };
  }),
}));
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return { ...actual, imaging: { ...actual.imaging, renderPersonalization: render.fn } };
});

let companyId: string;
let ctx: ReturnType<typeof tenantContext>;
let templateId: string;
let connId: string;

beforeAll(async () => {
  companyId = (await createCompany()).id;
  ctx = tenantContext(companyId, (await createUser(companyId, "owner")).id, "owner");
  templateId = (await createNameTemplate(companyId)).id;
  connId = (await createConnection(companyId)).id;
});

const exists = async (key: string) => (await headObject(key)).exists;
const artOf = (itemId: string) =>
  withTenant(companyId, async (tx) => ({
    art: (await tx.select().from(itemArtwork).where(eq(itemArtwork.orderItemId, itemId)))[0],
    item: (await tx.select().from(orderItems).where(eq(orderItems.id, itemId)))[0],
  }));

async function renderedItem(name: string) {
  const { order, items } = await createOrder(companyId, connId, { state: "ready" });
  const itemId = items[0]?.id as string;
  await withTenant(companyId, (tx) =>
    renderItemArtwork(tx, ctx, itemId, { templateId, values: { name } }),
  );
  return { orderId: order.id, itemId };
}

describe("superseded renders", () => {
  it("a re-render deletes the render it replaces and keeps the new one", async () => {
    const { itemId } = await renderedItem("Ana");
    const first = (await artOf(itemId)).art?.fileKey as string;
    expect(await exists(first)).toBe(true);
    await withTenant(companyId, (tx) => rerenderArtwork(tx, ctx, itemId));
    const after = await artOf(itemId);
    const second = after.art?.fileKey as string;
    expect(second).not.toBe(first);
    expect(after.item?.artworkKey).toBe(second);
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(true);
  });

  it("never deletes a key outside the company's artwork prefix", async () => {
    const { itemId } = await renderedItem("Cy");
    const design = await putObject(`${companyId}/design/shared-${itemId}.png`, "png", "image/png");
    await withSystem((tx) =>
      tx
        .update(itemArtwork)
        .set({ fileKey: design, previewKey: design })
        .where(eq(itemArtwork.orderItemId, itemId)),
    );
    await withTenant(companyId, (tx) => rerenderArtwork(tx, ctx, itemId));
    expect(await exists(design)).toBe(true);
  });
});

describe("purged artwork", () => {
  it("approve answers CONFLICT; new values re-render it and it can be approved again", async () => {
    const { orderId, itemId } = await renderedItem("Dee");
    const old = (await artOf(itemId)).art?.fileKey as string;
    await withTenant(companyId, (tx) => redactBuyerText(tx, [orderId], { scope: "all" }));
    expect((await artOf(itemId)).art?.status).toBe("purged");
    expect(await exists(old)).toBe(false);

    await expect(
      withTenant(companyId, (tx) => approveArtwork(tx, ctx, itemId)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await artOf(itemId)).art?.status).toBe("purged");

    const updated = await withTenant(companyId, (tx) =>
      updateArtworkValues(tx, ctx, { orderItemId: itemId, values: { name: "Eve" }, approve: true }),
    );
    expect(updated.status).toBe("approved");
    expect(updated.values).toEqual({ name: "Eve" });
    const back = await artOf(itemId);
    expect(back.item?.artworkStatus).toBe("approved");
    expect(back.item?.artworkKey).toBe(updated.fileKey);
    expect(await exists(updated.fileKey as string)).toBe(true);
  });
});
