/**
 * Golden vectors and properties for the settlement domain (plan row 5).
 *
 * Materialized BEFORE the implementation (TDD). Together with the plan's
 * SET-01..SET-03 and the multi-expense netting example this file is the
 * canonical source for aggregate balances and deterministic settlement.
 *
 * Conventions:
 * - All amounts are integer minor units (cents for EUR).
 * - A positive balance is a debtor (owes the group); a negative balance is
 *   a creditor (the group owes them).
 * - Transfers are greedy: debtors and creditors are sorted by descending
 *   amount with ties broken by canonical member order, then the smallest
 *   remaining amount moves until both sides are zero.
 * - `settle` never claims global minimality; it only guarantees
 *   determinism and a transfer count of at most n-1 (n = members with a
 *   non-zero balance).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  computeBalances,
  SettlementAssertionError,
  type SettlementExpense,
  settle,
  type Transfer,
} from "../../../src/domain/settlement";

const MAX_MEMBERS = 8;
const MAX_EXPENSES = 5;

const memberIds = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `m${index}`);

interface SettlementVector {
  id: string;
  title: string;
  expenses: SettlementExpense[];
  canonicalOrder: string[];
  totalSpentMinor: number;
  totalOwedMinor: number;
  balances: Record<string, number>;
  transfers: Transfer[];
}

/** Golden vectors: SET-01..SET-04. */
const settlementVectors: SettlementVector[] = [
  {
    id: "SET-01",
    title: "four-member equal expense settles with three transfers",
    expenses: [
      {
        paidByMemberId: "A",
        totalMinor: 40000,
        shares: [
          { memberId: "A", shareMinor: 10000 },
          { memberId: "B", shareMinor: 10000 },
          { memberId: "C", shareMinor: 10000 },
          { memberId: "D", shareMinor: 10000 },
        ],
        voided: false,
      },
    ],
    canonicalOrder: ["A", "B", "C", "D"],
    totalSpentMinor: 40000,
    totalOwedMinor: 30000,
    balances: { A: -30000, B: 10000, C: 10000, D: 10000 },
    transfers: [
      { fromMemberId: "B", toMemberId: "A", amountMinor: 10000 },
      { fromMemberId: "C", toMemberId: "A", amountMinor: 10000 },
      { fromMemberId: "D", toMemberId: "A", amountMinor: 10000 },
    ],
  },
  {
    id: "SET-02",
    title: "multi-expense netting collapses to one 75 transfer",
    expenses: [
      {
        paidByMemberId: "A",
        totalMinor: 300,
        shares: [
          { memberId: "A", shareMinor: 175 },
          { memberId: "B", shareMinor: 125 },
        ],
        voided: false,
      },
      {
        paidByMemberId: "B",
        totalMinor: 100,
        shares: [
          { memberId: "A", shareMinor: 50 },
          { memberId: "B", shareMinor: 50 },
        ],
        voided: false,
      },
    ],
    canonicalOrder: ["A", "B"],
    totalSpentMinor: 400,
    totalOwedMinor: 75,
    balances: { A: -75, B: 75 },
    transfers: [{ fromMemberId: "B", toMemberId: "A", amountMinor: 75 }],
  },
  {
    id: "SET-03",
    title: "equal creditors break ties by canonical member order",
    expenses: [
      {
        paidByMemberId: "A",
        totalMinor: 30,
        shares: [
          { memberId: "A", shareMinor: 10 },
          { memberId: "C", shareMinor: 20 },
        ],
        voided: false,
      },
      {
        paidByMemberId: "B",
        totalMinor: 30,
        shares: [
          { memberId: "B", shareMinor: 10 },
          { memberId: "C", shareMinor: 20 },
        ],
        voided: false,
      },
    ],
    canonicalOrder: ["A", "B", "C"],
    totalSpentMinor: 60,
    totalOwedMinor: 40,
    balances: { A: -20, B: -20, C: 40 },
    transfers: [
      { fromMemberId: "C", toMemberId: "A", amountMinor: 20 },
      { fromMemberId: "C", toMemberId: "B", amountMinor: 20 },
    ],
  },
  {
    id: "SET-04",
    title: "smallest remaining amount moves until both sides are zero",
    expenses: [
      {
        paidByMemberId: "A",
        totalMinor: 35,
        shares: [
          { memberId: "A", shareMinor: 20 },
          { memberId: "D", shareMinor: 15 },
        ],
        voided: false,
      },
      {
        paidByMemberId: "D",
        totalMinor: 20,
        shares: [
          { memberId: "D", shareMinor: 0 },
          { memberId: "B", shareMinor: 10 },
          { memberId: "C", shareMinor: 10 },
        ],
        voided: false,
      },
    ],
    canonicalOrder: ["A", "B", "C", "D"],
    totalSpentMinor: 55,
    totalOwedMinor: 20,
    balances: { A: -15, B: 10, C: 10, D: -5 },
    transfers: [
      { fromMemberId: "B", toMemberId: "A", amountMinor: 10 },
      { fromMemberId: "C", toMemberId: "A", amountMinor: 5 },
      { fromMemberId: "C", toMemberId: "D", amountMinor: 5 },
    ],
  },
];

describe("computeBalances", () => {
  it.each(settlementVectors)("$id: $title", (vector) => {
    const result = computeBalances(vector.expenses);

    expect(result.totalSpentMinor).toBe(vector.totalSpentMinor);
    expect(result.totalOwedMinor).toBe(vector.totalOwedMinor);
    expect(Object.fromEntries(result.balances)).toEqual(vector.balances);
  });

  it("excludes voided expenses from totals and balances", () => {
    const result = computeBalances([
      ...settlementVectors[0].expenses,
      {
        paidByMemberId: "B",
        totalMinor: 99999,
        shares: [{ memberId: "B", shareMinor: 99999 }],
        voided: true,
      },
    ]);

    expect(result.totalSpentMinor).toBe(40000);
    expect(Object.fromEntries(result.balances)).toEqual({
      A: -30000,
      B: 10000,
      C: 10000,
      D: 10000,
    });
  });

  it("does not reconcile a voided expense", () => {
    const result = computeBalances([
      {
        paidByMemberId: "A",
        totalMinor: 100,
        shares: [{ memberId: "A", shareMinor: 30 }],
        voided: true,
      },
    ]);

    expect(result.totalSpentMinor).toBe(0);
    expect(result.balances.size).toBe(0);
  });

  it("returns zeros for an empty expense set", () => {
    const result = computeBalances([]);

    expect(result.totalSpentMinor).toBe(0);
    expect(result.totalOwedMinor).toBe(0);
    expect(result.balances.size).toBe(0);
  });

  it("keeps a zero-net member in the balance map", () => {
    const result = computeBalances([
      {
        paidByMemberId: "A",
        totalMinor: 500,
        shares: [{ memberId: "A", shareMinor: 500 }],
        voided: false,
      },
    ]);

    expect(Object.fromEntries(result.balances)).toEqual({ A: 0 });
    expect(result.totalOwedMinor).toBe(0);
  });

  it("credits a payer who is not a participant of their own expense", () => {
    const result = computeBalances([
      {
        paidByMemberId: "B",
        totalMinor: 1000,
        shares: [
          { memberId: "A", shareMinor: 1000 },
          { memberId: "B", shareMinor: 0 },
        ],
        voided: false,
      },
    ]);

    expect(Object.fromEntries(result.balances)).toEqual({ B: -1000, A: 1000 });
  });

  it("throws a named assertion error when shares do not reconcile", () => {
    const expenses: SettlementExpense[] = [
      {
        paidByMemberId: "A",
        totalMinor: 300,
        shares: [{ memberId: "A", shareMinor: 175 }],
        voided: false,
      },
    ];

    expect(() => computeBalances(expenses)).toThrow(SettlementAssertionError);
    expect(() => computeBalances(expenses)).toThrow(
      /shares sum to 175, expected 300/,
    );
  });

  it("throws a named assertion error on a negative share", () => {
    const expenses: SettlementExpense[] = [
      {
        paidByMemberId: "A",
        totalMinor: 100,
        shares: [
          { memberId: "A", shareMinor: 150 },
          { memberId: "B", shareMinor: -50 },
        ],
        voided: false,
      },
    ];

    expect(() => computeBalances(expenses)).toThrow(SettlementAssertionError);
    expect(() => computeBalances(expenses)).toThrow(
      /share for B must be a non-negative integer/,
    );
  });

  it("throws a named assertion error on a zero total", () => {
    const expenses: SettlementExpense[] = [
      {
        paidByMemberId: "A",
        totalMinor: 0,
        shares: [{ memberId: "A", shareMinor: 0 }],
        voided: false,
      },
    ];

    expect(() => computeBalances(expenses)).toThrow(SettlementAssertionError);
    expect(() => computeBalances(expenses)).toThrow(
      /expense total must be a positive integer/,
    );
  });

  it("throws a named assertion error on a negative total", () => {
    const expenses: SettlementExpense[] = [
      {
        paidByMemberId: "A",
        totalMinor: -100,
        shares: [{ memberId: "A", shareMinor: -100 }],
        voided: false,
      },
    ];

    expect(() => computeBalances(expenses)).toThrow(SettlementAssertionError);
    expect(() => computeBalances(expenses)).toThrow(
      /expense total must be a positive integer/,
    );
  });

  it("throws a named assertion error on a non-integer total", () => {
    const expenses: SettlementExpense[] = [
      {
        paidByMemberId: "A",
        totalMinor: 100.5,
        shares: [{ memberId: "A", shareMinor: 100.5 }],
        voided: false,
      },
    ];

    expect(() => computeBalances(expenses)).toThrow(SettlementAssertionError);
  });

  it("throws a named assertion error on a non-integer share", () => {
    const expenses: SettlementExpense[] = [
      {
        paidByMemberId: "A",
        totalMinor: 100,
        shares: [{ memberId: "A", shareMinor: 100.5 }],
        voided: false,
      },
    ];

    expect(() => computeBalances(expenses)).toThrow(SettlementAssertionError);
  });
});

describe("settle", () => {
  it.each(settlementVectors)("$id: $title", (vector) => {
    const balances = new Map<string, number>(Object.entries(vector.balances));

    expect(settle(balances, vector.canonicalOrder)).toEqual(vector.transfers);
  });

  it("returns no transfers for an empty balance map", () => {
    expect(settle(new Map(), [])).toEqual([]);
  });

  it("returns no transfers when every balance is zero", () => {
    const balances = new Map([
      ["A", 0],
      ["B", 0],
    ]);

    expect(settle(balances, ["A", "B"])).toEqual([]);
  });

  it("breaks debtor ties by canonical member order", () => {
    const balances = new Map([
      ["A", -20],
      ["B", 10],
      ["C", 10],
    ]);

    expect(settle(balances, ["C", "B", "A"])).toEqual([
      { fromMemberId: "C", toMemberId: "A", amountMinor: 10 },
      { fromMemberId: "B", toMemberId: "A", amountMinor: 10 },
    ]);
  });

  it("sorts members missing from the canonical order last", () => {
    const balances = new Map([
      ["A", -20],
      ["B", 10],
      ["C", 10],
    ]);

    expect(settle(balances, ["A", "B"])).toEqual([
      { fromMemberId: "B", toMemberId: "A", amountMinor: 10 },
      { fromMemberId: "C", toMemberId: "A", amountMinor: 10 },
    ]);
  });

  it("throws a named assertion error when balances do not sum to zero", () => {
    const balances = new Map([
      ["A", -10],
      ["B", 5],
    ]);

    expect(() => settle(balances, ["A", "B"])).toThrow(
      SettlementAssertionError,
    );
    expect(() => settle(balances, ["A", "B"])).toThrow(
      /balances must sum to zero, got -5/,
    );
  });

  it("does not mutate the input balance map", () => {
    const balances = new Map([
      ["A", -75],
      ["B", 75],
    ]);

    settle(balances, ["A", "B"]);

    expect(Object.fromEntries(balances)).toEqual({ A: -75, B: 75 });
  });
});

// Cuts drawn from [0, total] become consecutive differences that sum to total.
const splitIntoParts = (total: number, cuts: number[]): number[] => {
  const points = [0, ...cuts, total].sort((a, b) => a - b);
  return points.slice(1).map((point, index) => point - points[index]);
};

describe("settlement properties (fast-check)", () => {
  it("consistent expenses produce zero-sum balances and exact totals over 1000 generated cases", () => {
    const property = fc.property(
      fc.integer({ min: 1, max: MAX_MEMBERS }),
      fc.integer({ min: 0, max: MAX_EXPENSES }),
      fc.array(fc.integer({ min: 0, max: MAX_MEMBERS - 1 }), {
        minLength: MAX_EXPENSES,
        maxLength: MAX_EXPENSES,
      }),
      fc.array(fc.integer({ min: 1, max: 1000 }), {
        minLength: MAX_EXPENSES,
        maxLength: MAX_EXPENSES,
      }),
      fc.array(
        fc.array(fc.nat({ max: 1000 }), {
          minLength: MAX_MEMBERS,
          maxLength: MAX_MEMBERS,
        }),
        { minLength: MAX_EXPENSES, maxLength: MAX_EXPENSES },
      ),
      fc.array(fc.boolean(), {
        minLength: MAX_EXPENSES,
        maxLength: MAX_EXPENSES,
      }),
      (count, expenseCount, payerPool, totalPool, cutPool, voidedPool) => {
        const ids = memberIds(count);
        const expenses: SettlementExpense[] = [];
        for (let index = 0; index < expenseCount; index++) {
          const cuts = cutPool[index].slice(0, count - 1);
          const maxCut = Math.max(0, ...cuts);
          const totalMinor = maxCut + totalPool[index];
          expenses.push({
            paidByMemberId: ids[payerPool[index] % count],
            totalMinor,
            shares: splitIntoParts(totalMinor, cuts).map(
              (shareMinor, shareIndex) => ({
                memberId: ids[shareIndex],
                shareMinor,
              }),
            ),
            voided: voidedPool[index],
          });
        }

        const result = computeBalances(expenses);

        let balanceSum = 0;
        let positiveSum = 0;
        for (const balance of result.balances.values()) {
          expect(Number.isInteger(balance)).toBe(true);
          balanceSum += balance;
          if (balance > 0) positiveSum += balance;
        }
        expect(balanceSum).toBe(0);
        expect(result.totalSpentMinor).toBe(
          expenses
            .filter((expense) => !expense.voided)
            .reduce((sum, expense) => sum + expense.totalMinor, 0),
        );
        expect(result.totalOwedMinor).toBe(positiveSum);
      },
    );

    const details = fc.check(property, { numRuns: 1000 });
    expect(details.failed).toBe(false);
    expect(details.numRuns).toBe(1000);
  });

  it("settle zeroes every balance with at most n-1 transfers over 1000 generated cases", () => {
    const property = fc.property(
      fc.integer({ min: 2, max: MAX_MEMBERS }),
      fc.array(fc.integer({ min: -200, max: 200 }), {
        minLength: MAX_MEMBERS - 1,
        maxLength: MAX_MEMBERS - 1,
      }),
      (count, valuePool) => {
        const prefix = valuePool.slice(0, count - 1);
        const balances = new Map(
          prefix.map((value, index) => [`m${index}`, value]),
        );
        balances.set(
          `m${count - 1}`,
          0 - prefix.reduce((sum, value) => sum + value, 0),
        );
        const ids = memberIds(count);

        const shuffledOrder = fc.sample(
          fc.shuffledSubarray(ids, {
            minLength: count,
            maxLength: count,
          }),
          { numRuns: 1 },
        )[0];
        const transfers = settle(balances, shuffledOrder);

        // Deterministic: a second run on the same input must agree.
        expect(settle(balances, shuffledOrder)).toEqual(transfers);

        for (const transfer of transfers) {
          expect(Number.isInteger(transfer.amountMinor)).toBe(true);
          expect(transfer.amountMinor).toBeGreaterThan(0);
          expect(transfer.fromMemberId).not.toBe(transfer.toMemberId);
        }

        const remaining = new Map(balances);
        for (const transfer of transfers) {
          remaining.set(
            transfer.fromMemberId,
            (remaining.get(transfer.fromMemberId) ?? 0) - transfer.amountMinor,
          );
          remaining.set(
            transfer.toMemberId,
            (remaining.get(transfer.toMemberId) ?? 0) + transfer.amountMinor,
          );
        }
        for (const balance of remaining.values()) {
          expect(balance).toBe(0);
        }

        const nonZeroCount = [...balances.values()].filter(
          (balance) => balance !== 0,
        ).length;
        expect(transfers.length).toBeLessThanOrEqual(
          Math.max(nonZeroCount - 1, 0),
        );
      },
    );

    const details = fc.check(property, { numRuns: 1000 });
    expect(details.failed).toBe(false);
    expect(details.numRuns).toBe(1000);
  });
});
