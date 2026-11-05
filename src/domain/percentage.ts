/**
 * Percentage entry for the split editor. One decimal place is accepted and
 * converted to basis points with integer arithmetic only: "33.3" is exactly
 * 3330 bp, and a second decimal place is rejected rather than truncated.
 */
import { BP_TOTAL } from "./money";

export const PERCENT_TOTAL_BP = BP_TOTAL;

export const PERCENT_ERRORS = {
  NEGATIVE: "Percentage can't be negative",
  ABOVE_100: "Percentage can't be more than 100",
  FORMAT: "Enter a number like 33.3",
} as const;

export interface PercentFieldState {
  bp: number | null;
  error?: string;
}

// An empty field and a trailing "." mid-typing are incomplete, not errors.
export function readPercentField(text: string): PercentFieldState {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.endsWith(".")) {
    return { bp: null };
  }
  if (trimmed.startsWith("-") || trimmed.startsWith("\u2212")) {
    return { bp: null, error: PERCENT_ERRORS.NEGATIVE };
  }
  if (!/^\d+(\.\d)?$/.test(trimmed)) {
    return { bp: null, error: PERCENT_ERRORS.FORMAT };
  }
  const [whole, fraction = "0"] = trimmed.split(".");
  const bp = Number(whole) * 100 + Number(fraction) * 10;
  if (bp > PERCENT_TOTAL_BP) {
    return { bp: null, error: PERCENT_ERRORS.ABOVE_100 };
  }
  return { bp };
}

export interface PercentSummary {
  states: Record<string, PercentFieldState>;
  allValid: boolean;
  sumBp: number;
  // Signed: positive means that much is still left to assign, negative is over.
  remainingBp: number;
  ready: boolean;
}

export function summarizePercentages(
  ids: readonly string[],
  values: Record<string, string>,
): PercentSummary {
  const states: Record<string, PercentFieldState> = {};
  let sumBp = 0;
  let allValid = ids.length > 0;
  for (const id of ids) {
    const state = readPercentField(values[id] ?? "");
    states[id] = state;
    if (state.bp === null) {
      allValid = false;
    } else {
      sumBp += state.bp;
    }
  }
  const remainingBp = PERCENT_TOTAL_BP - sumBp;
  return {
    states,
    allValid,
    sumBp,
    remainingBp,
    ready: allValid && sumBp === PERCENT_TOTAL_BP,
  };
}

export function formatBasisPoints(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = bp % 100;
  if (fraction === 0) {
    return `${whole}%`;
  }
  return `${(bp / 100).toFixed(fraction % 10 === 0 ? 1 : 2)}%`;
}
