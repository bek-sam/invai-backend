import { describe, expect, it } from "vitest";
import { withTenant } from "../../db/client";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { createTemplate, updateTemplate } from "./service";

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
