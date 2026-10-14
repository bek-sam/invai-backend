import { describe, expect, it } from "vitest";
import { designFiles, orderItems } from "../../schema";
import {
  chunkRows,
  insertChunked,
  MAX_PARAMS_PER_STATEMENT,
  MAX_ROWS_PER_STATEMENT,
  rowsPerStatement,
} from "./insert";

/* Spec rule: at most 5,000 rows per statement, always under the 65,535-parameter limit. */
describe("chunked inserts", () => {
  it("never puts more than 5,000 rows in one chunk, however narrow the row", () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => ({ a: i }));
    const chunks = chunkRows(rows);
    expect(chunks.map((c) => c.length)).toEqual([5000, 5000, 2000]);
    expect(MAX_ROWS_PER_STATEMENT).toBe(5000);
  });

  it("keeps wide rows under the parameter limit", () => {
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, i]));
    const chunks = chunkRows(Array.from({ length: 10_000 }, () => ({ ...wide })));
    for (const c of chunks) {
      expect(c.length * 40).toBeLessThanOrEqual(65_535);
      expect(c.length).toBeLessThanOrEqual(5000);
    }
    expect(rowsPerStatement(40)).toBe(Math.floor(MAX_PARAMS_PER_STATEMENT / 40));
  });

  it("sizes chunks by the widest row", () => {
    const rows = [{ a: 1 }, { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 }];
    expect(rowsPerStatement(10)).toBe(5000);
    expect(chunkRows(rows)).toHaveLength(1);
  });

  it("issues one insert per chunk through the production helper, none for no rows", async () => {
    const sizes: number[] = [];
    const tx = {
      insert: () => ({
        values: async (v: unknown[]) => {
          sizes.push(v.length);
        },
      }),
    };
    expect(await insertChunked(tx, designFiles, [])).toBe(0);
    expect(sizes).toEqual([]);
    const rows = Array.from({ length: 11_000 }, (_, i) => ({ i })) as never[];
    expect(await insertChunked(tx, orderItems, rows)).toBe(11_000);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(5000);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(11_000);
  });
});
