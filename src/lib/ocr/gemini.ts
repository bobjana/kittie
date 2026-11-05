import { Buffer } from "node:buffer";

import { GoogleGenAI, Type } from "@google/genai";

import { env } from "@/lib/env";

import type {
  OcrProvider,
  OcrProviderInput,
  OcrProviderResult,
} from "./provider";

const EXTRACTION_PROMPT =
  "Extract the final total paid, including tax and tip. " +
  "Do not return a subtotal or a line item.";

const EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    amount: {
      type: Type.STRING,
      description: "Final total paid as a decimal string, e.g. 12.50",
    },
    currency: {
      type: Type.STRING,
      description: "ISO 4217 currency code printed on the receipt, e.g. EUR",
    },
    date: {
      type: Type.STRING,
      description: "Receipt date as YYYY-MM-DD, empty string when unreadable",
    },
    merchant: {
      type: Type.STRING,
      description: "Merchant name as printed on the receipt",
    },
  },
  required: ["amount", "currency", "date", "merchant"],
} as const;

export class GeminiOcrProvider implements OcrProvider {
  readonly name = "gemini" as const;

  private client: GoogleGenAI | null = null;

  private getClient(): GoogleGenAI {
    if (this.client === null) {
      this.client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY ?? "" });
    }
    return this.client;
  }

  async extract(input: OcrProviderInput): Promise<OcrProviderResult> {
    try {
      const ai = this.getClient();
      const response = await ai.models.generateContent({
        model: env.GEMINI_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { text: EXTRACTION_PROMPT },
              {
                inlineData: {
                  mimeType: input.mime,
                  data: Buffer.from(input.image).toString("base64"),
                },
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: EXTRACTION_SCHEMA,
        },
      });
      const text = response.text ?? "";
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { ok: false, reason: "provider returned malformed JSON" };
      }
      const extraction = {
        amount: typeof parsed.amount === "string" ? parsed.amount : "",
        currency: typeof parsed.currency === "string" ? parsed.currency : "",
        date: typeof parsed.date === "string" ? parsed.date : "",
        merchant: typeof parsed.merchant === "string" ? parsed.merchant : "",
      };
      if (extraction.amount === "" || extraction.currency === "") {
        return {
          ok: false,
          reason: "provider returned an incomplete extraction",
        };
      }
      return { ok: true, extraction };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `gemini api error: ${message}` };
    }
  }
}
