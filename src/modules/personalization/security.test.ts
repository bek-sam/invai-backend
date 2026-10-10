import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { itemArtwork } from "../../db/schema";
import { objectKey, putObject } from "../../lib/s3";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { createNameTemplate, seedItemArt } from "../privacy/buyer-text.fixtures";
import {
  createTemplate,
  previewTemplate,
  renderValues,
  updateArtworkValues,
  updateTemplate,
} from "./service";

const render = vi.hoisted(() => ({
  seen: [] as Record<string, string>[],
  fn: vi.fn(async (input: { out_key: string; values: Record<string, string> }) => {
    render.seen.push(input.values);
    return { key: input.out_key, width_px: 10, height_px: 10, flags: [] };
  }),
}));
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return { ...actual, imaging: { ...actual.imaging, renderPersonalization: render.fn } };
});

beforeEach(() => {
  render.seen.length = 0;
  render.fn.mockClear();
});

describe("personalization templates", () => {
  it("refuse background keys outside the company's prefix", async () => {
    const companyId = (await createCompany()).id;
    const other = (await createCompany()).id;
    const ctx = tenantContext(companyId, (await createUser(companyId, "designer")).id, "designer");
    const input = { name: "Name tee", widthIn: 10, heightIn: 4, dpi: 300, slots: [] };
    await expect(
      withTenant(companyId, (tx) =>
        createTemplate(tx, ctx, { ...input, backgroundKey: `${other}/template_background/x.png` }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const ok = await withTenant(companyId, (tx) =>
      createTemplate(tx, ctx, {
        ...input,
        backgroundKey: `${companyId}/template_background/x.png`,
      }),
    );
    await expect(
      withTenant(companyId, (tx) =>
        updateTemplate(tx, ctx, { id: ok.id, backgroundKey: `${companyId}/../${other}/x.png` }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("S-60: photo-slot values reach imaging only as the render company's own keys", () => {
  it("B's staff can't render A's photo key (edit, preview), and a stored one never reaches imaging", async () => {
    const a = (await createCompany()).id;
    const aPhoto = await putObject(objectKey(a, "photo", "jpg"), "a-buyer", "image/jpeg");
    const b = (await createCompany()).id;
    const ctx = tenantContext(b, (await createUser(b, "owner")).id, "owner");
    const tpl = await createNameTemplate(b);
    const conn = await createConnection(b);
    const { items } = await createOrder(b, conn.id, { state: "ready" });
    const itemId = items[0]?.id as string;
    await seedItemArt(b, itemId, tpl.id);

    await expect(
      withTenant(b, (tx) =>
        updateArtworkValues(tx, ctx, {
          orderItemId: itemId,
          values: { photo: aPhoto },
          approve: false,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      withTenant(b, (tx) => previewTemplate(tx, ctx, { id: tpl.id, values: { photo: aPhoto } })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // A value stored before the fix: a text-only edit with approve re-renders without it and
    // does not approve.
    await withSystem((tx) =>
      tx
        .update(itemArtwork)
        .set({ values: { name: "Ana", photo: aPhoto } })
        .where(eq(itemArtwork.orderItemId, itemId)),
    );
    const out = await withTenant(b, (tx) =>
      updateArtworkValues(tx, ctx, { orderItemId: itemId, values: { name: "Eva" }, approve: true }),
    );
    expect(out.status).toBe("flagged");
    expect(render.seen.length).toBe(1);
    expect(render.seen.some((v) => Object.values(v).includes(aPhoto))).toBe(false);
  });

  it("the choke point drops every non-own photo value and fails closed on a malformed out key", async () => {
    const a = (await createCompany()).id;
    const b = (await createCompany()).id;
    const tpl = await createNameTemplate(b);
    const own = `${b}/photo/x.jpg`;
    const bad = [
      `${a}/photo/x.jpg`,
      `${b}/../${a}/photo/x.jpg`,
      `${b}//x.jpg`,
      `${b}/x.jpg\n`,
      `${b.toUpperCase()}/x.jpg`,
      `/${b}/x.jpg`,
      b,
      `${b}/`,
      `s3://bucket/${b}/x.jpg`,
    ];
    for (const photo of bad) {
      const out = await renderValues(tpl, { name: "Ana", photo }, objectKey(b, "artwork", "png"));
      expect(out.droppedPhotoSlots).toEqual(["photo"]);
    }
    for (const outKey of [b, `${b}/`, `${b}/../x.png`, `x/${b}/a.png`, "", `${b}x/a.png`]) {
      const out = await renderValues(tpl, { name: "Ana", photo: own }, outKey);
      expect(out.droppedPhotoSlots).toEqual(["photo"]);
    }
    expect(render.seen.every((v) => v.photo === undefined)).toBe(true);

    const ok = await renderValues(tpl, { name: "Ana", photo: own }, objectKey(b, "artwork", "png"));
    expect(ok.droppedPhotoSlots).toEqual([]);
    expect(render.seen.at(-1)).toEqual({ name: "Ana", photo: own });

    const fgn = await renderValues(
      { ...tpl, backgroundKey: `${a}/template_background/x.png` },
      { name: "Ana" },
      objectKey(b, "artwork", "png"),
    );
    expect(fgn.status).toBe("failed");
    expect(render.fn).toHaveBeenCalledTimes(bad.length + 6 + 1);
  });
});
