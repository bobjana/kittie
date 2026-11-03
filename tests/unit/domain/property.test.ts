import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BP_TOTAL } from "../../../src/domain/money";
import { computeShares } from "../../../src/domain/split";
import {
  type ExpenseValidationInput,
  validateExpenseInput,
} from "../../../src/domain/validation";

const MAX_MEMBERS = 8;

const memberIds = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `m${index}`);

// Cuts drawn from [0, total] become consecutive differences that sum to total.
const splitIntoParts = (total: number, cuts: number[]): number[] => {
  const points = [0, ...cuts, total].sort((a, b) => a - b);
  return points.slice(1).map((point, index) => point - points[index]);
};

const equalSplitProperty = fc.property(
  fc.integer({ min: 1, max: MAX_MEMBERS }),
  fc.array(fc.nat({ max: 500 }), {
    minLength: MAX_MEMBERS,
    maxLength: MAX_MEMBERS,
  }),
  fc.integer({ min: 1, max: 5000 }),
  (count, personalPool, remainderPool) => {
    const personals = personalPool.slice(0, count);
    const totalMinor =
      personals.reduce((sum, personal) => sum + personal, 0) + remainderPool;
    const participants = personals.map((personalMinor, index) => ({
      memberId: `m${index}`,
      personalMinor,
    }));

    const result = computeShares({
      totalMinor,
      mode: "equal",
      participants,
    });
    const shares = result.shares.map((share) => share.shareMinor);

    expect(result.shares.map((share) => share.memberId)).toEqual(
      memberIds(count),
    );
    expect(shares).toHaveLength(count);
    for (const share of shares) {
      expect(Number.isInteger(share)).toBe(true);
      expect(share).toBeGreaterThanOrEqual(0);
    }
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(totalMinor);
    expect(result.remainderMinor).toBe(0);
  },
);

const percentageSplitProperty = fc.property(
  fc.integer({ min: 1, max: MAX_MEMBERS }),
  fc.array(fc.nat({ max: 500 }), {
    minLength: MAX_MEMBERS,
    maxLength: MAX_MEMBERS,
  }),
  fc.integer({ min: 1, max: 5000 }),
  fc.array(fc.nat({ max: BP_TOTAL }), {
    minLength: MAX_MEMBERS,
    maxLength: MAX_MEMBERS,
  }),
  (count, personalPool, remainderPool, bpCutPool) => {
    const personals = personalPool.slice(0, count);
    const personalTotal = personals.reduce(
      (sum, personal) => sum + personal,
      0,
    );
    const totalMinor = personalTotal + remainderPool;
    const remainderTotal = totalMinor - personalTotal;
    const basisPoints = splitIntoParts(BP_TOTAL, bpCutPool.slice(0, count - 1));
    const participants = personals.map((personalMinor, index) => ({
      memberId: `m${index}`,
      personalMinor,
      splitBp: basisPoints[index],
    }));

    const result = computeShares({
      totalMinor,
      mode: "percentage",
      participants,
    });
    const shares = result.shares.map((share) => share.shareMinor);

    expect(shares).toHaveLength(count);
    for (const share of shares) {
      expect(Number.isInteger(share)).toBe(true);
      expect(share).toBeGreaterThanOrEqual(0);
    }
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(totalMinor);
    expect(result.remainderMinor).toBe(0);

    shares.forEach((share, index) => {
      const deviation = Math.abs(
        share * BP_TOTAL -
          personals[index] * BP_TOTAL -
          remainderTotal * basisPoints[index],
      );
      expect(deviation).toBeLessThanOrEqual(BP_TOTAL);
    });
  },
);

const validInputProperty = fc.property(
  fc.integer({ min: 1, max: MAX_MEMBERS }),
  fc.array(fc.nat({ max: 500 }), {
    minLength: MAX_MEMBERS,
    maxLength: MAX_MEMBERS,
  }),
  fc.integer({ min: 1, max: 5000 }),
  fc.array(fc.nat({ max: BP_TOTAL }), {
    minLength: MAX_MEMBERS,
    maxLength: MAX_MEMBERS,
  }),
  fc.boolean(),
  (count, personalPool, remainderPool, bpCutPool, usePercentage) => {
    const personals = personalPool.slice(0, count);
    const totalMinor =
      personals.reduce((sum, personal) => sum + personal, 0) + remainderPool;
    const basisPoints = splitIntoParts(BP_TOTAL, bpCutPool.slice(0, count - 1));
    const participants = personals.map((personalMinor, index) => ({
      memberId: `m${index}`,
      personalMinor,
      ...(usePercentage ? { splitBp: basisPoints[index] } : {}),
    }));
    const input: ExpenseValidationInput = {
      totalMinor,
      mode: usePercentage ? "percentage" : "equal",
      payerMemberId: "m0",
      memberIds: memberIds(count),
      participants,
    };

    expect(validateExpenseInput(input)).toEqual({ ok: true });
  },
);

const negativePersonalProperty = fc.property(
  fc.integer({ min: 1, max: 10000 }),
  fc.nat({ max: 10000 }),
  (totalMinor, magnitude) => {
    const result = validateExpenseInput({
      totalMinor,
      mode: "equal",
      payerMemberId: "m0",
      memberIds: ["m0"],
      participants: [{ memberId: "m0", personalMinor: -(magnitude + 1) }],
    });

    expect(result).toEqual({
      ok: false,
      code: "NEGATIVE_PERSONAL",
      message: expect.any(String),
    });
  },
);

const personalSumProperty = fc.property(
  fc.integer({ min: 1, max: 9999 }),
  fc.integer({ min: 1, max: 9999 }),
  (firstPersonal, gap) => {
    const totalMinor = firstPersonal + gap;
    const secondPersonal = gap + 1;
    const result = validateExpenseInput({
      totalMinor,
      mode: "equal",
      payerMemberId: "m0",
      memberIds: ["m0", "m1"],
      participants: [
        { memberId: "m0", personalMinor: firstPersonal },
        { memberId: "m1", personalMinor: secondPersonal },
      ],
    });

    expect(result).toEqual({
      ok: false,
      code: "PERSONAL_SUM_EXCEEDS_TOTAL",
      message: expect.any(String),
    });
  },
);

const pctSumProperty = fc.property(
  fc.integer({ min: 1, max: 10000 }),
  fc.nat({ max: 9999 }),
  (totalMinor, firstBp) => {
    const result = validateExpenseInput({
      totalMinor,
      mode: "percentage",
      payerMemberId: "m0",
      memberIds: ["m0", "m1"],
      participants: [
        { memberId: "m0", personalMinor: 0, splitBp: firstBp },
        { memberId: "m1", personalMinor: 0, splitBp: 9999 - firstBp },
      ],
    });

    expect(result).toEqual({
      ok: false,
      code: "PCT_SUM_INVALID",
      message: expect.any(String),
    });
  },
);

const emptyParticipantsProperty = fc.property(
  fc.integer({ min: 1, max: 10000 }),
  (totalMinor) => {
    const result = validateExpenseInput({
      totalMinor,
      mode: "equal",
      payerMemberId: "m0",
      memberIds: ["m0"],
      participants: [],
    });

    expect(result).toEqual({
      ok: false,
      code: "EMPTY_PARTICIPANTS",
      message: expect.any(String),
    });
  },
);

describe("split properties (fast-check)", () => {
  it("equal splits sum exactly to the total over 1000 generated cases", () => {
    const details = fc.check(equalSplitProperty, { numRuns: 1000 });
    expect(details.failed).toBe(false);
    expect(details.numRuns).toBe(1000);
  });

  it("percentage splits stay within one minor unit over 1000 generated cases", () => {
    const details = fc.check(percentageSplitProperty, { numRuns: 1000 });
    expect(details.failed).toBe(false);
    expect(details.numRuns).toBe(1000);
  });

  it("accepts every generated valid input over 1000 cases", () => {
    const details = fc.check(validInputProperty, { numRuns: 1000 });
    expect(details.failed).toBe(false);
    expect(details.numRuns).toBe(1000);
  });

  it("rejects a negative personal over 1000 cases", () => {
    const details = fc.check(negativePersonalProperty, { numRuns: 1000 });
    expect(details.failed).toBe(false);
    expect(details.numRuns).toBe(1000);
  });

  it("rejects a personal sum above the total over 1000 cases", () => {
    const details = fc.check(personalSumProperty, { numRuns: 1000 });
    expect(details.failed).toBe(false);
    expect(details.numRuns).toBe(1000);
  });

  it("rejects a percentage sum below 10000 over 1000 cases", () => {
    const details = fc.check(pctSumProperty, { numRuns: 1000 });
    expect(details.failed).toBe(false);
    expect(details.numRuns).toBe(1000);
  });

  it("rejects an empty participant list over 1000 cases", () => {
    const details = fc.check(emptyParticipantsProperty, { numRuns: 1000 });
    expect(details.failed).toBe(false);
    expect(details.numRuns).toBe(1000);
  });
});
