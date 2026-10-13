import { describe, expect, it } from "vitest";
import { contentDisposition } from "./s3";

/* T-49-1 (S-86): the UTF-8 filename* part must survive an emoji across the 150-unit cut. */
describe("contentDisposition", () => {
  const across = `${"a".repeat(149)}😀tail`;

  it("does not throw on an emoji straddling unit 150 and drops it whole", () => {
    const h = contentDisposition(across);
    expect(h).toContain(`filename*=UTF-8''${"a".repeat(149)}`);
    expect(h).not.toContain("%F0");
    expect(h).not.toContain("%EF%BF%BD");
  });

  it("does not throw on a lone surrogate and encodes it as U+FFFD", () => {
    expect(() => contentDisposition("a\uD83Db.png")).not.toThrow();
    expect(contentDisposition("a\uD83Db.png")).toContain("filename*=UTF-8''a%EF%BF%BDb.png");
  });

  it("keeps a plain name and a whole emoji that fits", () => {
    expect(contentDisposition("sheet.png")).toBe(
      `attachment; filename="sheet.png"; filename*=UTF-8''sheet.png`,
    );
    expect(contentDisposition("😀.png")).toContain("filename*=UTF-8''%F0%9F%98%80.png");
  });
});
