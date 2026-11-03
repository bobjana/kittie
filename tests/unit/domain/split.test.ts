import { describe, expect, it } from "vitest";
import { computeShares } from "../../../src/domain/split";
import { allSplitVectors } from "./vectors";

describe("computeShares", () => {
  it.each(allSplitVectors)("$id: $title", (vector) => {
    const result = computeShares({
      totalMinor: vector.totalMinor,
      mode: vector.mode,
      participants: vector.participants,
    });

    expect(result.shares.map((share) => share.shareMinor)).toEqual(
      vector.expected,
    );
    expect(result.shares.map((share) => share.memberId)).toEqual(
      vector.participants.map((participant) => participant.memberId),
    );
    const assigned = result.shares.reduce(
      (sum, share) => sum + share.shareMinor,
      0,
    );
    expect(assigned).toBe(vector.totalMinor);
    expect(result.remainderMinor).toBe(0);
  });

  it("treats a missing splitBp as zero basis points on trusted input", () => {
    const result = computeShares({
      totalMinor: 1000,
      mode: "percentage",
      participants: [
        { memberId: "A", personalMinor: 0, splitBp: 5000 },
        { memberId: "B", personalMinor: 0 },
        { memberId: "C", personalMinor: 0, splitBp: 5000 },
      ],
    });

    expect(result.shares.map((share) => share.shareMinor)).toEqual([
      500, 0, 500,
    ]);
  });

  it("gives a single leftover minor unit to the first member", () => {
    const result = computeShares({
      totalMinor: 1,
      mode: "equal",
      participants: [
        { memberId: "A", personalMinor: 0 },
        { memberId: "B", personalMinor: 0 },
        { memberId: "C", personalMinor: 0 },
      ],
    });

    expect(result.shares.map((share) => share.shareMinor)).toEqual([1, 0, 0]);
    expect(result.remainderMinor).toBe(0);
  });
});
