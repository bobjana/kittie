import { createHash } from "node:crypto";

import type {
  OcrProvider,
  OcrProviderInput,
  OcrProviderResult,
} from "./provider";

/**
 * Deterministic fake provider: the fixture is keyed by the image sha256, so
 * the same upload always yields the same extraction.
 */
export class FakeOcrProvider implements OcrProvider {
  readonly name = "fake" as const;

  async extract(input: OcrProviderInput): Promise<OcrProviderResult> {
    const sha256 = createHash("sha256").update(input.image).digest("hex");
    return {
      ok: true,
      extraction: {
        amount: "12.50",
        currency: "EUR",
        date: "2026-11-04",
        merchant: `Fixture Merchant ${sha256.slice(0, 8)}`,
      },
    };
  }
}
