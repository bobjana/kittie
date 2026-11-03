/**
 * Golden vectors for the money/split domain (plan row 4).
 *
 * Materialized BEFORE the implementation (TDD). Together with docs/MONEY.md
 * this file is the canonical source for EQ-01..EQ-08, PCT-01..PCT-05,
 * V-01..V-15 and EDIT-01..EDIT-05.
 *
 * Conventions:
 * - All amounts are integer minor units (cents for EUR).
 * - Shares are expected in canonical participant order (the order given in
 *   `participants`).
 * - `payerMemberId` and `memberIds` belong to the validation input; they do
 *   not influence computeShares itself (the payer may be any event member,
 *   not necessarily a participant).
 */
import type { ParticipantInput, SplitMode } from "../../../src/domain/split";

export interface SplitVector {
  id: string;
  title: string;
  totalMinor: number;
  mode: SplitMode;
  participants: ParticipantInput[];
  expected: number[];
  payerMemberId: string;
  memberIds: string[];
}

export interface RejectionVector {
  id: string;
  title: string;
  input: {
    totalMinor: number;
    mode: string;
    payerMemberId: string;
    memberIds: string[];
    participants: ParticipantInput[];
  };
  code: string;
}

/** Equal mode: personal carve-out, then base + remainder in canonical order. */
export const equalVectors: SplitVector[] = [
  {
    id: "EQ-01",
    title: "personal carve-out, even remainder",
    totalMinor: 30000,
    mode: "equal",
    participants: [
      { memberId: "A", personalMinor: 5000 },
      { memberId: "B", personalMinor: 0 },
    ],
    expected: [17500, 12500],
    payerMemberId: "A",
    memberIds: ["A", "B"],
  },
  {
    id: "EQ-02",
    title: "equal base with remainder to first member",
    totalMinor: 1000,
    mode: "equal",
    participants: [
      { memberId: "A", personalMinor: 0 },
      { memberId: "B", personalMinor: 0 },
      { memberId: "C", personalMinor: 0 },
    ],
    expected: [334, 333, 333],
    payerMemberId: "A",
    memberIds: ["A", "B", "C"],
  },
  {
    id: "EQ-03",
    title: "personal of one minor unit with odd remainder",
    totalMinor: 1000,
    mode: "equal",
    participants: [
      { memberId: "A", personalMinor: 1 },
      { memberId: "B", personalMinor: 0 },
    ],
    expected: [501, 499],
    payerMemberId: "A",
    memberIds: ["A", "B"],
  },
  {
    id: "EQ-04",
    title: "personal equals total on the payer",
    totalMinor: 1000,
    mode: "equal",
    participants: [
      { memberId: "A", personalMinor: 1000 },
      { memberId: "B", personalMinor: 0 },
    ],
    expected: [1000, 0],
    payerMemberId: "A",
    memberIds: ["A", "B"],
  },
  {
    id: "EQ-05",
    title: "personal equals total on a non-payer",
    totalMinor: 1000,
    mode: "equal",
    participants: [
      { memberId: "A", personalMinor: 1000 },
      { memberId: "B", personalMinor: 0 },
    ],
    expected: [1000, 0],
    payerMemberId: "B",
    memberIds: ["A", "B"],
  },
  {
    id: "EQ-06",
    title: "single member takes the whole amount",
    totalMinor: 500,
    mode: "equal",
    participants: [{ memberId: "A", personalMinor: 0 }],
    expected: [500],
    payerMemberId: "A",
    memberIds: ["A"],
  },
  {
    id: "EQ-07",
    title: "two personal carve-outs before the equal split",
    totalMinor: 10000,
    mode: "equal",
    participants: [
      { memberId: "A", personalMinor: 2000 },
      { memberId: "B", personalMinor: 3000 },
      { memberId: "C", personalMinor: 0 },
    ],
    expected: [3667, 4667, 1666],
    payerMemberId: "A",
    memberIds: ["A", "B", "C"],
  },
  {
    id: "EQ-08",
    title: "the 300/50/2 QA example",
    totalMinor: 300,
    mode: "equal",
    participants: [
      { memberId: "A", personalMinor: 50 },
      { memberId: "B", personalMinor: 0 },
    ],
    expected: [175, 125],
    payerMemberId: "A",
    memberIds: ["A", "B"],
  },
];

/** Percentage mode: basis points apply to the remainder AFTER the carve-out. */
export const percentageVectors: SplitVector[] = [
  {
    id: "PCT-01",
    title: "clean basis point split",
    totalMinor: 1000,
    mode: "percentage",
    participants: [
      { memberId: "A", personalMinor: 0, splitBp: 5000 },
      { memberId: "B", personalMinor: 0, splitBp: 3000 },
      { memberId: "C", personalMinor: 0, splitBp: 2000 },
    ],
    expected: [500, 300, 200],
    payerMemberId: "A",
    memberIds: ["A", "B", "C"],
  },
  {
    id: "PCT-02",
    title: "largest remainder gives the extra unit to C",
    totalMinor: 1000,
    mode: "percentage",
    participants: [
      { memberId: "A", personalMinor: 0, splitBp: 3333 },
      { memberId: "B", personalMinor: 0, splitBp: 3333 },
      { memberId: "C", personalMinor: 0, splitBp: 3334 },
    ],
    expected: [333, 333, 334],
    payerMemberId: "A",
    memberIds: ["A", "B", "C"],
  },
  {
    id: "PCT-03",
    title: "tie on the remainder falls back to canonical order",
    totalMinor: 999,
    mode: "percentage",
    participants: [
      { memberId: "A", personalMinor: 0, splitBp: 5000 },
      { memberId: "B", personalMinor: 0, splitBp: 5000 },
    ],
    expected: [500, 499],
    payerMemberId: "A",
    memberIds: ["A", "B"],
  },
  {
    id: "PCT-04",
    title: "percentages apply to the remainder, not the total",
    totalMinor: 30000,
    mode: "percentage",
    participants: [
      { memberId: "A", personalMinor: 5000, splitBp: 5000 },
      { memberId: "B", personalMinor: 0, splitBp: 5000 },
    ],
    expected: [17500, 12500],
    payerMemberId: "A",
    memberIds: ["A", "B"],
  },
  {
    id: "PCT-05",
    title: "zero basis points take nothing from the remainder",
    totalMinor: 1000,
    mode: "percentage",
    participants: [
      { memberId: "A", personalMinor: 0, splitBp: 6000 },
      { memberId: "B", personalMinor: 0, splitBp: 4000 },
      { memberId: "C", personalMinor: 0, splitBp: 0 },
    ],
    expected: [600, 400, 0],
    payerMemberId: "A",
    memberIds: ["A", "B", "C"],
  },
];

/** Edit scenarios: recompute after a plausible user edit, each a valid input. */
export const editVectors: SplitVector[] = [
  {
    id: "EDIT-01",
    title: "adding a personal contribution re-balances the equal split",
    totalMinor: 1000,
    mode: "equal",
    participants: [
      { memberId: "A", personalMinor: 100 },
      { memberId: "B", personalMinor: 0 },
    ],
    expected: [550, 450],
    payerMemberId: "A",
    memberIds: ["A", "B"],
  },
  {
    id: "EDIT-02",
    title: "switching from equal to percentage keeps the total",
    totalMinor: 1000,
    mode: "percentage",
    participants: [
      { memberId: "A", personalMinor: 0, splitBp: 2500 },
      { memberId: "B", personalMinor: 0, splitBp: 7500 },
    ],
    expected: [250, 750],
    payerMemberId: "A",
    memberIds: ["A", "B"],
  },
  {
    id: "EDIT-03",
    title: "removing a participant re-balances the equal split",
    totalMinor: 1000,
    mode: "equal",
    participants: [
      { memberId: "A", personalMinor: 0 },
      { memberId: "B", personalMinor: 0 },
    ],
    expected: [500, 500],
    payerMemberId: "A",
    memberIds: ["A", "B"],
  },
  {
    id: "EDIT-04",
    title: "swapping percentages swaps the shares",
    totalMinor: 1000,
    mode: "percentage",
    participants: [
      { memberId: "A", personalMinor: 0, splitBp: 4000 },
      { memberId: "B", personalMinor: 0, splitBp: 6000 },
    ],
    expected: [400, 600],
    payerMemberId: "A",
    memberIds: ["A", "B"],
  },
  {
    id: "EDIT-05",
    title: "clearing the payer's personal amount re-balances",
    totalMinor: 30000,
    mode: "equal",
    participants: [
      { memberId: "A", personalMinor: 0 },
      { memberId: "B", personalMinor: 0 },
    ],
    expected: [15000, 15000],
    payerMemberId: "A",
    memberIds: ["A", "B"],
  },
];

export const allSplitVectors: SplitVector[] = [
  ...equalVectors,
  ...percentageVectors,
  ...editVectors,
];

/** Rejection vectors: each input must fail with the named error code. */
export const rejectionVectors: RejectionVector[] = [
  {
    id: "V-01",
    title: "personal exceeds the total",
    input: {
      totalMinor: 1000,
      mode: "equal",
      payerMemberId: "A",
      memberIds: ["A"],
      participants: [{ memberId: "A", personalMinor: 1500 }],
    },
    code: "PERSONAL_EXCEEDS_TOTAL",
  },
  {
    id: "V-02",
    title: "negative personal",
    input: {
      totalMinor: 1000,
      mode: "equal",
      payerMemberId: "A",
      memberIds: ["A"],
      participants: [{ memberId: "A", personalMinor: -100 }],
    },
    code: "NEGATIVE_PERSONAL",
  },
  {
    id: "V-03",
    title: "zero total",
    input: {
      totalMinor: 0,
      mode: "equal",
      payerMemberId: "A",
      memberIds: ["A"],
      participants: [{ memberId: "A", personalMinor: 0 }],
    },
    code: "TOTAL_NOT_POSITIVE",
  },
  {
    id: "V-04",
    title: "percentage sum is not 10000",
    input: {
      totalMinor: 1000,
      mode: "percentage",
      payerMemberId: "A",
      memberIds: ["A", "B"],
      participants: [
        { memberId: "A", personalMinor: 0, splitBp: 5000 },
        { memberId: "B", personalMinor: 0, splitBp: 4999 },
      ],
    },
    code: "PCT_SUM_INVALID",
  },
  {
    id: "V-05",
    title: "basis points above 10000",
    input: {
      totalMinor: 1000,
      mode: "percentage",
      payerMemberId: "A",
      memberIds: ["A", "B"],
      participants: [
        { memberId: "A", personalMinor: 0, splitBp: 10001 },
        { memberId: "B", personalMinor: 0, splitBp: -1 },
      ],
    },
    code: "BP_OUT_OF_RANGE",
  },
  {
    id: "V-06",
    title: "payer is not an event member",
    input: {
      totalMinor: 1000,
      mode: "equal",
      payerMemberId: "C",
      memberIds: ["A", "B"],
      participants: [
        { memberId: "A", personalMinor: 0 },
        { memberId: "B", personalMinor: 0 },
      ],
    },
    code: "PAYER_NOT_MEMBER",
  },
  {
    id: "V-07",
    title: "empty participants",
    input: {
      totalMinor: 1000,
      mode: "equal",
      payerMemberId: "A",
      memberIds: ["A"],
      participants: [],
    },
    code: "EMPTY_PARTICIPANTS",
  },
  {
    id: "V-08",
    title: "personal sum exceeds the total",
    input: {
      totalMinor: 1000,
      mode: "equal",
      payerMemberId: "A",
      memberIds: ["A", "B"],
      participants: [
        { memberId: "A", personalMinor: 600 },
        { memberId: "B", personalMinor: 600 },
      ],
    },
    code: "PERSONAL_SUM_EXCEEDS_TOTAL",
  },
  {
    id: "V-09",
    title: "percentage mode without basis points",
    input: {
      totalMinor: 1000,
      mode: "percentage",
      payerMemberId: "A",
      memberIds: ["A", "B"],
      participants: [
        { memberId: "A", personalMinor: 0, splitBp: 5000 },
        { memberId: "B", personalMinor: 0 },
      ],
    },
    code: "BP_REQUIRED",
  },
  {
    id: "V-10",
    title: "unknown split mode",
    input: {
      totalMinor: 1000,
      mode: "ratio",
      payerMemberId: "A",
      memberIds: ["A"],
      participants: [{ memberId: "A", personalMinor: 0 }],
    },
    code: "INVALID_MODE",
  },
  {
    id: "V-11",
    title: "non-integer total",
    input: {
      totalMinor: 12.5,
      mode: "equal",
      payerMemberId: "A",
      memberIds: ["A"],
      participants: [{ memberId: "A", personalMinor: 0 }],
    },
    code: "TOTAL_NOT_INTEGER",
  },
  {
    id: "V-12",
    title: "non-integer personal",
    input: {
      totalMinor: 1000,
      mode: "equal",
      payerMemberId: "A",
      memberIds: ["A"],
      participants: [{ memberId: "A", personalMinor: 3.5 }],
    },
    code: "PERSONAL_NOT_INTEGER",
  },
  {
    id: "V-13",
    title: "negative total",
    input: {
      totalMinor: -1000,
      mode: "equal",
      payerMemberId: "A",
      memberIds: ["A"],
      participants: [{ memberId: "A", personalMinor: 0 }],
    },
    code: "TOTAL_NOT_POSITIVE",
  },
  {
    id: "V-14",
    title: "non-integer basis points",
    input: {
      totalMinor: 1000,
      mode: "percentage",
      payerMemberId: "A",
      memberIds: ["A", "B"],
      participants: [
        { memberId: "A", personalMinor: 0, splitBp: 5000.5 },
        { memberId: "B", personalMinor: 0, splitBp: 4999.5 },
      ],
    },
    code: "BP_OUT_OF_RANGE",
  },
  {
    id: "V-15",
    title: "negative basis points",
    input: {
      totalMinor: 1000,
      mode: "percentage",
      payerMemberId: "A",
      memberIds: ["A", "B"],
      participants: [
        { memberId: "A", personalMinor: 0, splitBp: 5000 },
        { memberId: "B", personalMinor: 0, splitBp: -1 },
      ],
    },
    code: "BP_OUT_OF_RANGE",
  },
];
