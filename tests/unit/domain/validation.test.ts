import { describe, expect, it } from "vitest";
import {
  type ExpenseValidationInput,
  validateExpenseInput,
} from "../../../src/domain/validation";
import { allSplitVectors, rejectionVectors } from "./vectors";

describe("validateExpenseInput", () => {
  it.each(allSplitVectors)("accepts $id: $title", (vector) => {
    const input: ExpenseValidationInput = {
      totalMinor: vector.totalMinor,
      mode: vector.mode,
      payerMemberId: vector.payerMemberId,
      memberIds: vector.memberIds,
      participants: vector.participants,
    };

    expect(validateExpenseInput(input)).toEqual({ ok: true });
  });

  it.each(rejectionVectors)("rejects $id with $code: $title", (vector) => {
    const result = validateExpenseInput(
      vector.input as unknown as ExpenseValidationInput,
    );

    expect(result).toEqual({
      ok: false,
      code: vector.code,
      message: expect.any(String),
    });
  });
});
