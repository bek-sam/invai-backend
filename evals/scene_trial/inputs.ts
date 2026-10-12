/*
 * Paid-run inputs, captured at import time. run.ts imports this module FIRST, so the values are
 * read before src/env.ts loads .env (same pattern as paidAiRequested in src/env.ts). A .env line
 * for either variable therefore never counts as explicit (T-41-5 round 2).
 */
export const explicitInputs: { budgetRaw: string | undefined; sinceRaw: string | undefined } = {
  budgetRaw: process.env.SCENE_TRIAL_BUDGET_CENTS,
  sinceRaw: process.env.SCENE_TRIAL_SINCE,
};
