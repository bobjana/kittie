/**
 * Lifecycle transition tests (plan row 6).
 *
 * The state machines behind open->closed->reopened events and open->voided
 * expenses. Pure transitions: who may act is a permission question answered
 * by src/domain/permissions.ts; here we only assert which transitions are
 * legal from a given state, including the stale-state adversarial journey.
 */
import { describe, expect, it } from "vitest";
import {
  type EventState,
  type EventTransitionAction,
  type ExpenseState,
  isIncludedInReports,
  LIFECYCLE_CODES,
  type LifecycleErrorCode,
  transitionEvent,
  voidExpense,
} from "../../../src/domain/lifecycle";

interface EventTransitionCase {
  from: EventState;
  action: EventTransitionAction;
  ok: boolean;
  state?: EventState;
  code?: LifecycleErrorCode;
}

interface ExpenseTransitionCase {
  from: ExpenseState;
  ok: boolean;
  state?: ExpenseState;
  code?: LifecycleErrorCode;
}

describe("transitionEvent", () => {
  it.each<EventTransitionCase>([
    { from: "open", action: "close", ok: true, state: "closed" },
    {
      from: "closed",
      action: "close",
      ok: false,
      code: LIFECYCLE_CODES.ALREADY_CLOSED,
    },
    { from: "closed", action: "reopen", ok: true, state: "open" },
    {
      from: "open",
      action: "reopen",
      ok: false,
      code: LIFECYCLE_CODES.NOT_CLOSED,
    },
  ])("$action from $from", ({ from, action, ok, state, code }) => {
    const result = transitionEvent(from, action);
    expect(result.ok).toBe(ok);
    if (result.ok) {
      expect(result.state).toBe(state);
    } else {
      expect(result.code).toBe(code);
      expect(typeof result.message).toBe("string");
    }
  });
});

describe("voidExpense", () => {
  it.each<ExpenseTransitionCase>([
    { from: "open", ok: true, state: "voided" },
    { from: "voided", ok: false, code: LIFECYCLE_CODES.ALREADY_VOIDED },
  ])("void from $from", ({ from, ok, state, code }) => {
    const result = voidExpense(from);
    expect(result.ok).toBe(ok);
    if (result.ok) {
      expect(result.state).toBe(state);
    } else {
      expect(result.code).toBe(code);
      expect(typeof result.message).toBe("string");
    }
  });
});

describe("stale-state journey (open -> closed -> reopened -> voided)", () => {
  it("walks the full sequence without allowing a stale retry", () => {
    let eventState = transitionEvent("open", "close");
    expect(eventState).toEqual({ ok: true, state: "closed" });

    // A second, stale close is refused.
    const staleClose = transitionEvent("closed", "close");
    expect(staleClose).toEqual({
      ok: false,
      code: LIFECYCLE_CODES.ALREADY_CLOSED,
      message: expect.any(String),
    });

    eventState = transitionEvent("closed", "reopen");
    expect(eventState).toEqual({ ok: true, state: "open" });

    // A stale reopen of an open event is refused.
    const staleReopen = transitionEvent("open", "reopen");
    expect(staleReopen).toEqual({
      ok: false,
      code: LIFECYCLE_CODES.NOT_CLOSED,
      message: expect.any(String),
    });

    const expenseState = voidExpense("open");
    expect(expenseState).toEqual({ ok: true, state: "voided" });

    // A second, stale void is refused.
    const staleVoid = voidExpense("voided");
    expect(staleVoid).toEqual({
      ok: false,
      code: LIFECYCLE_CODES.ALREADY_VOIDED,
      message: expect.any(String),
    });
  });
});

describe("report inclusion", () => {
  it.each([
    { state: "open", included: true },
    { state: "voided", included: false },
  ] as const)("isIncludedInReports($state) -> $included", ({
    state,
    included,
  }) => {
    expect(isIncludedInReports(state)).toBe(included);
  });
});
