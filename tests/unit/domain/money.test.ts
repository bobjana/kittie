import { describe, expect, it } from "vitest";
import { BP_TOTAL, isIntegerMinor } from "../../../src/domain/money";

describe("money invariants", () => {
  it("defines 10000 basis points as one whole", () => {
    expect(BP_TOTAL).toBe(10000);
  });

  it.each([0, 1, 100, 1e13, -1])("accepts integer values %s", (value) => {
    expect(isIntegerMinor(value)).toBe(true);
  });

  it.each([
    1.5,
    NaN,
    Number.POSITIVE_INFINITY,
    "5",
    null,
    undefined,
  ])("rejects non-integer values %s", (value) => {
    expect(isIntegerMinor(value)).toBe(false);
  });
});
