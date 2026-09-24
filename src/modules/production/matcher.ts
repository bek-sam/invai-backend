import type {
  MISMATCH_REASONS,
  NEXT_ACTIONS,
  OrderItemState,
  SCAN_ACTIONS,
} from "@invai/contracts";
import type { BlankRef } from "./views";

/*
 * The scan check as a pure function: given what the transfer QR resolved to and what the second
 * code resolved to, decide ok / mismatch, the next action and whether the item moves. The
 * service does the lookups and the side effects; tests exercise this directly.
 */

export type ScanAction = (typeof SCAN_ACTIONS)[number];
export type MismatchReason = (typeof MISMATCH_REASONS)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];

/** What the second scan (blank label, tote or another transfer) resolved to. */
export type SecondCode =
  | { kind: "none" }
  | { kind: "blank"; blank: BlankRef | null }
  | { kind: "bin"; code: string; orderId: string | null; picked: boolean }
  | { kind: "transfer"; orderId: string | null; designId: string | null };

export type MatchInput = {
  action: ScanAction;
  scannedAt: Date;
  transfer: { id: string; scrapped: boolean; status: string } | null;
  item: {
    id: string;
    orderId: string;
    state: OrderItemState;
    transferId: string | null;
    designId: string | null;
    stateChangedAt: Date;
  } | null;
  expected: BlankRef | null;
  second: SecondCode;
};

export type MatchOutcome = {
  ok: boolean;
  mismatch: MismatchReason | null;
  message: string;
  nextAction: NextAction;
  /** The state the item moves to when ok (press -> pressed); null = record only. */
  moveTo: OrderItemState | null;
};

/** Tablet clocks drift; only a scan clearly older than the move counts as stale. */
const STALE_TOLERANCE_MS = 5_000;

const DONE_STATES: OrderItemState[] = ["pressed", "packed", "shipped", "delivered"];
const BEFORE_TRANSFER: OrderItemState[] = [
  "imported",
  "needs_mapping",
  "ready",
  "needs_artwork",
  "on_sheet",
];

export function nextActionFor(state: OrderItemState): NextAction {
  switch (state) {
    case "imported":
    case "needs_mapping":
    case "needs_artwork":
    case "ready":
    case "on_sheet":
      return "wait_for_transfer";
    case "transfer_in":
      return "press";
    case "pressed":
      return "qc";
    case "packed":
      return "pack";
    case "on_hold":
      return "hold";
    default:
      return "nothing";
  }
}

const fail = (mismatch: MismatchReason, message: string, nextAction: NextAction): MatchOutcome => ({
  ok: false,
  mismatch,
  message,
  nextAction,
  moveTo: null,
});

const blankText = (b: BlankRef) => `${b.brand} ${b.style} ${b.color} ${b.size}`;

/** Compare the scanned blank with the one the transfer's item needs. */
export function compareBlank(expected: BlankRef, scanned: BlankRef): MismatchReason | null {
  if (expected.variantId === scanned.variantId) return null;
  const sameStyle =
    expected.styleCode.toLowerCase() === scanned.styleCode.toLowerCase() &&
    expected.brand.toLowerCase() === scanned.brand.toLowerCase();
  if (!sameStyle) return "wrong_style";
  if (expected.colorCode.toLowerCase() !== scanned.colorCode.toLowerCase()) return "wrong_color";
  if (expected.sizeCode.toLowerCase() !== scanned.sizeCode.toLowerCase()) return "wrong_size";
  return null;
}

/** Checks the second code for pick/press. Null = the blank is right. */
function checkBlank(input: MatchInput, requirePick: boolean): MatchOutcome | null {
  const { second, expected, item } = input;
  if (!item) return null;
  switch (second.kind) {
    case "none":
      return fail("blank_required", "Scan the blank label too", "pick_blank");
    case "blank": {
      if (!second.blank) return fail("unknown_blank", "Blank label not recognized", "pick_blank");
      if (!expected) return fail("unknown_blank", "This item has no blank mapped", "nothing");
      const reason = compareBlank(expected, second.blank);
      if (!reason) return null;
      const label =
        reason === "wrong_color"
          ? "Wrong color"
          : reason === "wrong_size"
            ? "Wrong size"
            : reason === "wrong_style"
              ? "Wrong style"
              : "Wrong blank";
      return fail(
        reason,
        `${label}: needs ${blankText(expected)}, scanned ${blankText(second.blank)}`,
        "pick_blank",
      );
    }
    case "bin":
      if (second.orderId !== item.orderId)
        return fail("wrong_order", `Tote ${second.code} holds another order`, "pick_blank");
      if (requirePick && !second.picked)
        return fail(
          "blank_required",
          "No blank was picked into this tote; scan the blank",
          "pick_blank",
        );
      return null;
    case "transfer":
      if (second.designId && item.designId && second.designId !== item.designId)
        return fail("wrong_design", "That transfer is a different design", "pick_blank");
      if (second.orderId !== item.orderId)
        return fail("wrong_order", "That transfer belongs to another order", "pick_blank");
      return fail("blank_required", "Scan the blank label, not a second transfer", "pick_blank");
  }
}

export function matchScan(input: MatchInput): MatchOutcome {
  const { transfer, item, action } = input;
  if (!transfer || !item) return fail("unknown_transfer", "Transfer not recognized", "nothing");
  if (item.state === "cancelled")
    return fail("item_cancelled", "Order item was cancelled", "nothing");
  if (item.state === "on_hold") return fail("item_on_hold", "Order is on hold", "hold");
  if (transfer.scrapped || transfer.status === "scrap" || item.transferId !== transfer.id)
    return fail("transfer_scrapped", "This transfer was replaced; don't press it", "nothing");

  // Past the step this scan performs: a replayed offline scan older than the move is stale.
  const beyond = () =>
    input.scannedAt.getTime() < item.stateChangedAt.getTime() - STALE_TOLERANCE_MS
      ? fail("stale_scan", "A later scan already moved this item", nextActionFor(item.state))
      : fail("already_processed", `Already ${item.state}`, nextActionFor(item.state));

  switch (action) {
    case "pick":
    case "press": {
      if (BEFORE_TRANSFER.includes(item.state))
        return fail("not_yet_received", "Transfer not received yet", "wait_for_transfer");
      if (DONE_STATES.includes(item.state)) return beyond();
      const blocked = checkBlank(input, action === "press");
      if (blocked) return blocked;
      return action === "press"
        ? { ok: true, mismatch: null, message: "Match: press", nextAction: "qc", moveTo: "pressed" }
        : { ok: true, mismatch: null, message: "Picked", nextAction: "press", moveTo: null };
    }
    case "qc_pass":
    case "qc_fail": {
      if (item.state === "pressed")
        return {
          ok: true,
          mismatch: null,
          message: action === "qc_pass" ? "QC passed" : "QC failed: reprint requested",
          nextAction: action === "qc_pass" ? "pack" : "reprint",
          moveTo: action === "qc_pass" ? "packed" : "ready",
        };
      if (item.state === "transfer_in") return fail("wrong_station", "Not pressed yet", "press");
      if (BEFORE_TRANSFER.includes(item.state))
        return fail("not_yet_received", "Transfer not received yet", "wait_for_transfer");
      return beyond();
    }
    case "pack": {
      if (item.state === "packed") {
        if (input.second.kind === "bin" && input.second.orderId !== item.orderId)
          return fail("wrong_order", `Tote ${input.second.code} holds another order`, "pack");
        return { ok: true, mismatch: null, message: "Packed", nextAction: "ship", moveTo: null };
      }
      if (item.state === "pressed") return fail("wrong_station", "QC this shirt first", "qc");
      if (item.state === "transfer_in") return fail("wrong_station", "Not pressed yet", "press");
      if (BEFORE_TRANSFER.includes(item.state))
        return fail("not_yet_received", "Transfer not received yet", "wait_for_transfer");
      return beyond();
    }
  }
}
