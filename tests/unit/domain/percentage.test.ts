import { describe, expect, it } from "vitest";
import {
  formatBasisPoints,
  PERCENT_ERRORS,
  readPercentField,
  summarizePercentages,
} from "../../../src/domain/percentage";
import { computeShares } from "../../../src/domain/split";

describe("readPercentField", () => {
  it.each([
    ["33.3", 3330],
    ["33.4", 3340],
    ["0", 0],
    ["0.1", 10],
    ["0.5", 50],
    ["50", 5000],
    ["99.9", 9990],
    ["100", 10000],
    ["100.0", 10000],
  ])("converts %s to %i basis points exactly", (text, expected) => {
    const state = readPercentField(text);
    expect(state.bp).toBe(expected);
    expect(state.error).toBeUndefined();
    expect(Number.isInteger(state.bp)).toBe(true);
  });

  it("treats an empty field and a half-typed decimal as incomplete", () => {
    expect(readPercentField("")).toEqual({ bp: null });
    expect(readPercentField("   ")).toEqual({ bp: null });
    expect(readPercentField("33.")).toEqual({ bp: null });
  });

  it("rejects a second decimal place instead of truncating it", () => {
    expect(readPercentField("33.34")).toEqual({
      bp: null,
      error: PERCENT_ERRORS.FORMAT,
    });
    expect(readPercentField("1e2")).toEqual({
      bp: null,
      error: PERCENT_ERRORS.FORMAT,
    });
    expect(readPercentField("abc")).toEqual({
      bp: null,
      error: PERCENT_ERRORS.FORMAT,
    });
  });

  it("rejects negative values", () => {
    for (const text of ["-1", "-0.1", "\u22125"]) {
      expect(readPercentField(text)).toEqual({
        bp: null,
        error: PERCENT_ERRORS.NEGATIVE,
      });
    }
  });

  it("rejects values above 100%", () => {
    for (const text of ["100.1", "101", "150", "1000"]) {
      expect(readPercentField(text)).toEqual({
        bp: null,
        error: PERCENT_ERRORS.ABOVE_100,
      });
    }
  });
});

describe("summarizePercentages", () => {
  it("marks a 33.3/33.3/33.4 split ready and sums to exactly 10000 bp", () => {
    const summary = summarizePercentages(["a", "b", "c"], {
      a: "33.3",
      b: "33.3",
      c: "33.4",
    });

    expect(summary.allValid).toBe(true);
    expect(summary.sumBp).toBe(10000);
    expect(summary.remainingBp).toBe(0);
    expect(summary.ready).toBe(true);
  });

  it("reports the remainder of a 50/40 split and refuses to be ready", () => {
    const summary = summarizePercentages(["a", "b"], { a: "50", b: "40" });

    expect(summary.allValid).toBe(true);
    expect(summary.sumBp).toBe(9000);
    expect(summary.remainingBp).toBe(1000);
    expect(summary.ready).toBe(false);
  });

  it("is never ready when a value is missing, invalid, or over 100%", () => {
    expect(summarizePercentages(["a", "b"], { a: "50" }).ready).toBe(false);
    expect(summarizePercentages(["a", "b"], { a: "50", b: "-10" }).ready).toBe(
      false,
    );
    expect(summarizePercentages(["a", "b"], { a: "100", b: "100" }).ready).toBe(
      false,
    );
    expect(summarizePercentages([], {}).ready).toBe(false);
  });
});

describe("formatBasisPoints", () => {
  it.each([
    [0, "0%"],
    [10, "0.1%"],
    [50, "0.5%"],
    [1000, "10%"],
    [3330, "33.3%"],
    [9000, "90%"],
    [10000, "100%"],
  ])("renders %i bp as %s", (bp, expected) => {
    expect(formatBasisPoints(bp)).toBe(expected);
  });
});

describe("percentage to share rounding contract", () => {
  it("yields 333/333/334 on 1000 from the 33.3/33.3/33.4 entry", () => {
    const summary = summarizePercentages(["a", "b", "c"], {
      a: "33.3",
      b: "33.3",
      c: "33.4",
    });
    expect(summary.ready).toBe(true);

    const { shares, remainderMinor } = computeShares({
      totalMinor: 1000,
      mode: "percentage",
      participants: ["a", "b", "c"].map((memberId) => ({
        memberId,
        personalMinor: 0,
        splitBp: summary.states[memberId].bp ?? 0,
      })),
    });

    expect(shares.map((share) => share.shareMinor)).toEqual([333, 333, 334]);
    expect(remainderMinor).toBe(0);
    const assigned = shares.reduce((sum, share) => sum + share.shareMinor, 0);
    expect(assigned).toBe(1000);
  });

  it("yields 333/333/334 on 1000 for the canonical 3333/3333/3334 basis points", () => {
    const { shares, remainderMinor } = computeShares({
      totalMinor: 1000,
      mode: "percentage",
      participants: [
        { memberId: "a", personalMinor: 0, splitBp: 3333 },
        { memberId: "b", personalMinor: 0, splitBp: 3333 },
        { memberId: "c", personalMinor: 0, splitBp: 3334 },
      ],
    });

    expect(shares.map((share) => share.shareMinor)).toEqual([333, 333, 334]);
    expect(remainderMinor).toBe(0);
  });
});
