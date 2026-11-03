export const BP_TOTAL = 10_000;

export function isIntegerMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}
