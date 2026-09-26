import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ComposePlacement, NestItem, RenderTemplate, TemplateSlot } from "./client";

/*
 * Drift guard (T-13-3, B-104). invai-imaging's request Pydantic models are the source of truth
 * for what the service accepts; client.ts's Zod schemas are a hand-kept mirror — there is no
 * shared codegen across the Python/TS boundary (audit B-104: "client.ts is a hand-kept copy").
 * This generates each Pydantic model's JSON Schema straight from the FastAPI app (`uv run
 * python`, no network, no running server needed) and compares its field names against the
 * matching Zod schema converted the same way (`z.toJSONSchema`), so a field added, removed or
 * renamed on either side fails here instead of silently 422ing (or silently dropping data) the
 * first time a real imaging call hits it.
 *
 * Only imaging's typed *request* models are comparable this way: every endpoint here returns a
 * plain `dict` on the Python side (see app/main.py), so there is no Pydantic response model to
 * diff RenderResult/NestResult/ComposeResult/QaCheckResult against.
 *
 * Zod is allowed to require a field the Pydantic model defaults (a stricter TS caller is safe);
 * the reverse — Pydantic requires it but Zod treats it as optional — is not: a caller could omit
 * it and get a 422 that nothing here would catch.
 */

const IMAGING_DIR = path.resolve(__dirname, "../../../../invai-imaging");

type JsonSchemaObject = { properties?: Record<string, unknown>; required?: string[] };

/** Pydantic models' OpenAPI component schemas, read straight from the FastAPI app object. */
function pydanticSchemas(names: string[]): Record<string, JsonSchemaObject> {
  const script = [
    "import app.main as m, json",
    "spec = m.app.openapi()",
    "schemas = spec['components']['schemas']",
    `print(json.dumps({n: schemas[n] for n in ${JSON.stringify(names)}}))`,
  ].join("\n");
  const out = execFileSync("uv", ["run", "python", "-c", script], {
    cwd: IMAGING_DIR,
    encoding: "utf8",
    timeout: 30_000,
  });
  return JSON.parse(out) as Record<string, JsonSchemaObject>;
}

function fieldsOf(json: JsonSchemaObject) {
  return {
    names: new Set(Object.keys(json.properties ?? {})),
    required: new Set(json.required ?? []),
  };
}

/** Fails with a readable diff when the two sides' field names or required-ness disagree. */
function assertNoDrift(label: string, zodSchema: z.ZodType, pydantic: JsonSchemaObject) {
  const zod = fieldsOf(z.toJSONSchema(zodSchema) as JsonSchemaObject);
  const py = fieldsOf(pydantic);
  expect(
    [...py.names].filter((n) => !zod.names.has(n)),
    `${label}: invai-imaging accepts these fields but client.ts's Zod schema doesn't know about them`,
  ).toEqual([]);
  expect(
    [...zod.names].filter((n) => !py.names.has(n)),
    `${label}: client.ts's Zod schema has these fields but invai-imaging doesn't accept them`,
  ).toEqual([]);
  expect(
    [...py.required].filter((n) => !zod.required.has(n)),
    `${label}: invai-imaging requires these fields but client.ts's Zod schema treats them as optional`,
  ).toEqual([]);
}

describe("imaging contract drift (T-13-3, B-104)", () => {
  let schemas: Record<string, JsonSchemaObject>;

  function pydantic(name: string): JsonSchemaObject {
    const s = schemas[name];
    if (!s) throw new Error(`invai-imaging has no component schema named ${name}`);
    return s;
  }

  beforeAll(() => {
    schemas = pydanticSchemas([
      "SlotModel",
      "TemplateModel",
      "NestItemModel",
      "ComposePlacementModel",
      "LabelModel",
    ]);
  });

  it("TemplateSlot matches SlotModel (personalization template slots)", () => {
    assertNoDrift("TemplateSlot/SlotModel", TemplateSlot, pydantic("SlotModel"));
  });

  it("RenderTemplate matches TemplateModel", () => {
    assertNoDrift("RenderTemplate/TemplateModel", RenderTemplate, pydantic("TemplateModel"));
  });

  it("NestItem matches NestItemModel (/nest)", () => {
    assertNoDrift("NestItem/NestItemModel", NestItem, pydantic("NestItemModel"));
  });

  it("ComposePlacement matches ComposePlacementModel, and its label matches LabelModel (/compose)", () => {
    assertNoDrift(
      "ComposePlacement/ComposePlacementModel",
      ComposePlacement,
      pydantic("ComposePlacementModel"),
    );
    assertNoDrift(
      "ComposePlacement.label/LabelModel",
      ComposePlacement.shape.label,
      pydantic("LabelModel"),
    );
  });
});
