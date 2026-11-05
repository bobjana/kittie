/**
 * OCR provider contract (row 16). A provider receives the re-encoded receipt
 * image and returns a structured extraction; every failure is a normal value,
 * never a thrown error, so the service can retry uniformly.
 *
 * The extracted amount is a decimal string ("12.50"); the service parses it
 * to integer minor units in the event currency. Never extract line items.
 */

export const OCR_PROVIDER_NAMES = ["gemini", "fake", "fail"] as const;

export type OcrProviderName = (typeof OCR_PROVIDER_NAMES)[number];

export interface OcrExtraction {
  /** Decimal string, e.g. "12.50" or "1,234.56" */
  amount: string;
  /** ISO 4217 currency code as printed on the receipt, e.g. "EUR" */
  currency: string;
  /** ISO date "YYYY-MM-DD" when parseable, otherwise "" */
  date: string;
  /** Merchant name as printed, never logged by the server */
  merchant: string;
}

export interface OcrProviderInput {
  /** Re-encoded image bytes (clean JPEG after row 15 processing). */
  image: Uint8Array;
  mime: string;
}

export type OcrProviderResult =
  | { ok: true; extraction: OcrExtraction }
  | { ok: false; reason: string };

export interface OcrProvider {
  readonly name: OcrProviderName;
  extract(input: OcrProviderInput): Promise<OcrProviderResult>;
}

export class OcrProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrProviderError";
  }
}

/**
 * Parses a printed decimal amount into integer minor units. Accepts both
 * decimal separators and thousands grouping ("1,234.56", "1.234,56", "12,50");
 * the last separator is treated as the decimal point. Rejects negatives,
 * signs, and strings with no separator (ambiguous integers).
 */
export function parseAmountToMinor(amount: string): number | null {
  const cleaned = amount.trim().replace(/[^\d.,]/g, "");
  if (cleaned.length === 0) {
    return null;
  }
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastDot);
  if (decimalIndex === -1) {
    return null;
  }
  const whole = cleaned.slice(0, decimalIndex).replace(/[.,]/g, "");
  const fraction = cleaned.slice(decimalIndex + 1).replace(/[^\d]/g, "");
  if (!/^\d+$/.test(whole) || !/^\d{1,2}$/.test(fraction)) {
    return null;
  }
  const minor =
    Number.parseInt(whole, 10) * 100 +
    Number.parseInt(fraction.padEnd(2, "0"), 10);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function parseIsoDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  const roundTrip = parsed.toISOString().slice(0, 10);
  return roundTrip === value ? value : null;
}
