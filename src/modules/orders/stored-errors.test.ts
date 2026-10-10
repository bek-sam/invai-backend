import { describe, expect, it, vi } from "vitest";
import { withTenant } from "../../db/client";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { bulkApply } from "./mapping";

/* B-353: a bulk-map failure is returned to the caller without the query's parameter values. */

vi.mock("../channels/sku", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/sku")>();
  return { ...actual, createRule: vi.fn(actual.createRule) };
});

import * as sku from "../channels/sku";

const VALUE = "maria.perez@example.com 4410 Mesquite Lane Phoenix AZ";

describe("orders mapping errors (B-353)", () => {
  it("a failed bulk mapping reports the query head, not its parameter values", async () => {
    const companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    const ctx = tenantContext(companyId, owner.id, "owner");
    vi.mocked(sku.createRule).mockImplementationOnce(async () => {
      throw new Error(`Failed query: insert into sku_rules\nparams: ${VALUE}`);
    });
    const res = await withTenant(companyId, (tx) =>
      bulkApply(tx, ctx, {
        mappings: [
          {
            channelSku: "SKU-1",
            designId: crypto.randomUUID(),
            blankVariantId: crypto.randomUUID(),
            saveRule: {} as never,
          },
        ],
      }),
    );
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]?.message).toMatch(/^Failed query/);
    expect(res.failed[0]?.message).not.toContain("Mesquite");
    expect(res.failed[0]?.message).not.toContain("maria.perez");
  });
});
