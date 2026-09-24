import { describe, expect, it } from "vitest";
import { type MatchInput, matchScan } from "./matcher";
import type { BlankRef } from "./views";

const blank = (over: Partial<BlankRef> = {}): BlankRef => ({
  variantId: "v-black-m",
  brand: "Gildan",
  style: "64000",
  styleCode: "64000",
  color: "Black",
  colorCode: "BLK",
  size: "M",
  sizeCode: "M",
  sku: "G64000-BLK-M",
  supplierSku: "B00760003",
  weightOz: 5.3,
  ...over,
});

const at = new Date("2026-09-24T12:00:00Z");

function input(over: Partial<MatchInput> = {}): MatchInput {
  return {
    action: "press",
    scannedAt: at,
    transfer: { id: "t1", scrapped: false, status: "received" },
    item: {
      id: "i1",
      orderId: "o1",
      state: "transfer_in",
      transferId: "t1",
      designId: "d1",
      stateChangedAt: new Date("2026-09-24T11:00:00Z"),
    },
    expected: blank(),
    second: { kind: "blank", blank: blank() },
    ...over,
  };
}

describe("scan matcher", () => {
  it("presses on an exact blank match", () => {
    const r = matchScan(input());
    expect(r).toMatchObject({ ok: true, mismatch: null, moveTo: "pressed", nextAction: "qc" });
  });

  it("blocks the wrong size, color and garment", () => {
    const size = matchScan(
      input({
        second: { kind: "blank", blank: blank({ variantId: "v2", size: "L", sizeCode: "L" }) },
      }),
    );
    expect(size).toMatchObject({ ok: false, mismatch: "wrong_size", moveTo: null });
    const color = matchScan(
      input({
        second: {
          kind: "blank",
          blank: blank({ variantId: "v3", color: "White", colorCode: "WHT" }),
        },
      }),
    );
    expect(color.mismatch).toBe("wrong_color");
    const style = matchScan(
      input({
        second: {
          kind: "blank",
          blank: blank({ variantId: "v4", styleCode: "1717", brand: "Comfort Colors" }),
        },
      }),
    );
    expect(style.mismatch).toBe("wrong_design");
    expect(color.message).toContain("needs Gildan 64000 Black M");
  });

  it("needs a known blank at press", () => {
    expect(matchScan(input({ second: { kind: "none" } })).mismatch).toBe("blank_required");
    expect(matchScan(input({ second: { kind: "blank", blank: null } })).mismatch).toBe(
      "unknown_blank",
    );
  });

  it("accepts the order's tote only after a pick", () => {
    const tote = (orderId: string | null, picked: boolean) =>
      matchScan(input({ second: { kind: "bin", code: "T-1", orderId, picked } }));
    expect(tote("o1", true).ok).toBe(true);
    expect(tote("o1", false).mismatch).toBe("blank_required");
    expect(tote("o2", true).mismatch).toBe("wrong_order");
  });

  it("rejects unknown, scrapped, held and cancelled transfers", () => {
    expect(matchScan(input({ transfer: null, item: null })).mismatch).toBe("unknown_transfer");
    expect(
      matchScan(input({ transfer: { id: "t1", scrapped: true, status: "scrap" } })).mismatch,
    ).toBe("transfer_scrapped");
    const base = input().item;
    if (!base) throw new Error("fixture");
    // The item was sent for a reprint: its current transfer is another one.
    expect(matchScan(input({ item: { ...base, transferId: "t2" } })).mismatch).toBe(
      "transfer_scrapped",
    );
    expect(matchScan(input({ item: { ...base, state: "on_hold" } })).mismatch).toBe("item_on_hold");
    expect(matchScan(input({ item: { ...base, state: "cancelled" } })).mismatch).toBe(
      "item_cancelled",
    );
    expect(matchScan(input({ item: { ...base, state: "on_sheet" } })).mismatch).toBe(
      "not_yet_received",
    );
  });

  it("tells already-processed from stale offline scans", () => {
    const base = input().item;
    if (!base) throw new Error("fixture");
    const pressed = {
      ...base,
      state: "pressed" as const,
      stateChangedAt: new Date("2026-09-24T12:00:00Z"),
    };
    expect(
      matchScan(input({ item: pressed, scannedAt: new Date("2026-09-24T12:05:00Z") })).mismatch,
    ).toBe("already_processed");
    expect(
      matchScan(input({ item: pressed, scannedAt: new Date("2026-09-24T11:00:00Z") })).mismatch,
    ).toBe("stale_scan");
    // Within the clock-drift tolerance it is not stale.
    expect(
      matchScan(input({ item: pressed, scannedAt: new Date("2026-09-24T11:59:58Z") })).mismatch,
    ).toBe("already_processed");
  });

  it("routes pick, qc and pack actions by state", () => {
    const base = input().item;
    if (!base) throw new Error("fixture");
    expect(matchScan(input({ action: "pick" }))).toMatchObject({
      ok: true,
      moveTo: null,
      nextAction: "press",
    });
    expect(matchScan(input({ action: "qc_pass" })).mismatch).toBe("wrong_station");
    expect(
      matchScan(input({ action: "qc_pass", item: { ...base, state: "pressed" } })),
    ).toMatchObject({
      ok: true,
      moveTo: "packed",
    });
    const packed = { ...base, state: "packed" as const };
    expect(matchScan(input({ action: "pack", item: packed, second: { kind: "none" } })).ok).toBe(
      true,
    );
    expect(
      matchScan(
        input({
          action: "pack",
          item: packed,
          second: { kind: "bin", code: "T-9", orderId: "o2", picked: true },
        }),
      ).mismatch,
    ).toBe("wrong_order");
    expect(
      matchScan(input({ action: "pack", item: { ...base, state: "pressed" } })).nextAction,
    ).toBe("qc");
  });
});
