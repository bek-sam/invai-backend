/*
 * Inventory service. The ledger primitives other modules call live in ./ledger.ts and are
 * re-exported here: orders reserve/release on ready/cancel, production consumes on press and
 * reads shelves for the pick queue.
 */
export {
  consumeForItem,
  getShelvesForBlanks,
  releaseForItems,
  reserveForItems,
} from "./ledger";
