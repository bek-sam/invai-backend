import { describe, expect, it } from "vitest";
import { foldAttributes } from "./service";

// ADR 0017 (B-167, T-22-5): the model's attribute list folds into the contract's string map.
describe("listing attributes fold (ADR 0017)", () => {
  it("trims keys, drops empty ones and keeps the first of a repeated key", () => {
    expect(
      foldAttributes([
        { key: " material ", value: "cotton" },
        { key: "", value: "dropped" },
        { key: "   ", value: "dropped too" },
        { key: "material", value: "polyester" },
        { key: "occasion", value: "birthday" },
      ]),
    ).toEqual({ material: "cotton", occasion: "birthday" });
    expect(foldAttributes([])).toEqual({});
  });

  it("keeps a __proto__ key as plain data", () => {
    const out = foldAttributes([{ key: "__proto__", value: "x" }]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(["__proto__"]);
  });
});
