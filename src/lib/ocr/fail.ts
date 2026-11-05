import type {
  OcrProvider,
  OcrProviderInput,
  OcrProviderResult,
} from "./provider";

export class FailOcrProvider implements OcrProvider {
  readonly name = "fail" as const;

  async extract(_input: OcrProviderInput): Promise<OcrProviderResult> {
    return { ok: false, reason: "fail_provider_always_fails" };
  }
}
