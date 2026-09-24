import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../db/client";
import { isSafeKey, objectKey, putObject } from "../../lib/s3";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { downloadUrl, presignUpload } from "./service";

describe("files", () => {
  let companyId: string;
  let otherId: string;
  let office: ReturnType<typeof tenantContext>;
  let presser: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    otherId = (await createCompany()).id;
    office = tenantContext(companyId, (await createUser(companyId, "office")).id, "office");
    presser = tenantContext(companyId, (await createUser(companyId, "presser")).id, "presser");
  });

  it("presigned uploads bind content type and exact size into the signature", async () => {
    const up = await withTenant(companyId, (tx) =>
      presignUpload(tx, office, {
        kind: "design",
        filename: "art.png",
        contentType: "image/png",
        sizeBytes: 10,
      }),
    );
    expect(up.fileKey.startsWith(`${companyId}/design/`)).toBe(true);
    const url = new URL(up.uploadUrl);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(900);
    // Real S3/MinIO: a different type or a bigger body is refused.
    const wrongType = await fetch(up.uploadUrl, {
      method: "PUT",
      body: "0123456789",
      headers: { "content-type": "text/html" },
    });
    expect(wrongType.status).toBe(403);
    const tooBig = await fetch(up.uploadUrl, {
      method: "PUT",
      body: "x".repeat(5000),
      headers: { "content-type": "image/png" },
    });
    expect(tooBig.status).toBe(403);
    const ok = await fetch(up.uploadUrl, {
      method: "PUT",
      body: "0123456789",
      headers: { "content-type": "image/png" },
    });
    expect(ok.status).toBe(200);
  });

  it("keys never carry user input beyond a short extension, and html is refused", async () => {
    const up = await withTenant(companyId, (tx) =>
      presignUpload(tx, office, {
        kind: "other",
        filename: "x.pdf/../../victim/design/evil",
        contentType: "application/octet-stream",
        sizeBytes: 10,
      }),
    );
    expect(up.fileKey).toMatch(
      new RegExp(`^${companyId}/other/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.bin$`),
    );
    await expect(
      withTenant(companyId, (tx) =>
        presignUpload(tx, office, {
          kind: "other",
          filename: "x.html",
          contentType: "text/html",
          sizeBytes: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TYPE" });
  });

  it("download URLs only for the caller's company, safe keys and allowed kinds", async () => {
    const own = await putObject(objectKey(companyId, "design", "png"), "png", "image/png");
    const res = await withTenant(companyId, (tx) =>
      downloadUrl(tx, presser, { fileKey: own, disposition: "attachment" }),
    );
    expect(new URL(res.url).searchParams.get("X-Amz-Expires")).toBe("900");

    const foreign = await putObject(objectKey(otherId, "design", "png"), "png", "image/png");
    for (const fileKey of [
      foreign,
      `${companyId}/../${foreign}`,
      `${companyId}//${foreign}`,
      `/${own}`,
    ]) {
      await expect(
        withTenant(companyId, (tx) => downloadUrl(tx, office, { fileKey, disposition: "inline" })),
        fileKey,
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }

    // Buyer-data kinds: raw payloads never, CSV imports and labels only for the roles using them.
    const raw = await putObject(objectKey(companyId, "raw", "json"), "{}", "application/json");
    const csv = await putObject(objectKey(companyId, "csv", "csv"), "a,b", "text/csv");
    const label = await putObject(objectKey(companyId, "label", "pdf"), "%PDF", "application/pdf");
    const get = (ctx: typeof office, fileKey: string) =>
      withTenant(companyId, (tx) => downloadUrl(tx, ctx, { fileKey, disposition: "inline" }));
    await expect(get(office, raw)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(get(presser, csv)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(get(presser, label)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await get(office, csv)).fileKey).toBe(csv);
    expect((await get(office, label)).fileKey).toBe(label);
  });

  it("isSafeKey accepts generated keys only", () => {
    expect(isSafeKey(objectKey(companyId, "template_background", "png"))).toBe(true);
    for (const bad of ["a/../b", "a/./b", "a//b", "/a/b", "a/b/", "a/.hidden", "a\\b", ""])
      expect(isSafeKey(bad), bad).toBe(false);
  });
});
