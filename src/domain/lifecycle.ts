/**
 * Lifecycle state machines for events and expenses (plan row 6).
 *
 * Pure transitions: permissions.ts decides who may act; this file decides
 * which transitions are legal from a given state. Events move
 * open -> closed -> open (reopened); expenses move open -> voided and are
 * terminal there. Voided expenses are excluded from reports.
 */
export type EventState = "open" | "closed";

export type ExpenseState = "open" | "voided";

export type EventTransitionAction = "close" | "reopen";

export const LIFECYCLE_CODES = {
  ALREADY_CLOSED: "ALREADY_CLOSED",
  NOT_CLOSED: "NOT_CLOSED",
  ALREADY_VOIDED: "ALREADY_VOIDED",
} as const;

export type LifecycleErrorCode =
  (typeof LIFECYCLE_CODES)[keyof typeof LIFECYCLE_CODES];

export type LifecycleFailure = {
  ok: false;
  code: LifecycleErrorCode;
  message: string;
};

export type EventTransitionResult =
  | { ok: true; state: EventState }
  | LifecycleFailure;

export type ExpenseTransitionResult =
  | { ok: true; state: ExpenseState }
  | LifecycleFailure;

export function transitionEvent(
  current: EventState,
  action: EventTransitionAction,
): EventTransitionResult {
  if (action === "close") {
    if (current === "open") {
      return { ok: true, state: "closed" };
    }
    return failure(
      LIFECYCLE_CODES.ALREADY_CLOSED,
      "the event is already closed",
    );
  }
  if (current === "closed") {
    return { ok: true, state: "open" };
  }
  return failure(LIFECYCLE_CODES.NOT_CLOSED, "the event is not closed");
}

export function voidExpense(current: ExpenseState): ExpenseTransitionResult {
  if (current === "open") {
    return { ok: true, state: "voided" };
  }
  return failure(
    LIFECYCLE_CODES.ALREADY_VOIDED,
    "the expense is already voided",
  );
}

export function isIncludedInReports(state: ExpenseState): boolean {
  return state !== "voided";
}

function failure(code: LifecycleErrorCode, message: string): LifecycleFailure {
  return { ok: false, code, message };
}
