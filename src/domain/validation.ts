import { BP_TOTAL, isIntegerMinor } from "./money";
import type { ParticipantInput, SplitMode } from "./split";

export const VALIDATION_CODES = {
  INVALID_MODE: "INVALID_MODE",
  TOTAL_NOT_INTEGER: "TOTAL_NOT_INTEGER",
  TOTAL_NOT_POSITIVE: "TOTAL_NOT_POSITIVE",
  EMPTY_PARTICIPANTS: "EMPTY_PARTICIPANTS",
  PERSONAL_NOT_INTEGER: "PERSONAL_NOT_INTEGER",
  NEGATIVE_PERSONAL: "NEGATIVE_PERSONAL",
  PERSONAL_EXCEEDS_TOTAL: "PERSONAL_EXCEEDS_TOTAL",
  PERSONAL_SUM_EXCEEDS_TOTAL: "PERSONAL_SUM_EXCEEDS_TOTAL",
  PAYER_NOT_MEMBER: "PAYER_NOT_MEMBER",
  BP_REQUIRED: "BP_REQUIRED",
  BP_OUT_OF_RANGE: "BP_OUT_OF_RANGE",
  PCT_SUM_INVALID: "PCT_SUM_INVALID",
} as const;

export type ValidationErrorCode =
  (typeof VALIDATION_CODES)[keyof typeof VALIDATION_CODES];

export interface ExpenseValidationInput {
  totalMinor: number;
  mode: SplitMode;
  payerMemberId: string;
  memberIds: string[];
  participants: ParticipantInput[];
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: ValidationErrorCode; message: string };

export function validateExpenseInput(
  input: ExpenseValidationInput,
): ValidationResult {
  if (input.mode !== "equal" && input.mode !== "percentage") {
    return failure(
      VALIDATION_CODES.INVALID_MODE,
      "split mode must be equal or percentage",
    );
  }
  if (!isIntegerMinor(input.totalMinor)) {
    return failure(
      VALIDATION_CODES.TOTAL_NOT_INTEGER,
      "total must be an integer number of minor units",
    );
  }
  if (input.totalMinor <= 0) {
    return failure(
      VALIDATION_CODES.TOTAL_NOT_POSITIVE,
      "total must be greater than zero",
    );
  }
  if (input.participants.length === 0) {
    return failure(
      VALIDATION_CODES.EMPTY_PARTICIPANTS,
      "at least one participant is required",
    );
  }

  let personalSum = 0;
  for (const participant of input.participants) {
    if (!isIntegerMinor(participant.personalMinor)) {
      return failure(
        VALIDATION_CODES.PERSONAL_NOT_INTEGER,
        "personal amounts must be integers",
      );
    }
    if (participant.personalMinor < 0) {
      return failure(
        VALIDATION_CODES.NEGATIVE_PERSONAL,
        "personal amounts cannot be negative",
      );
    }
    if (participant.personalMinor > input.totalMinor) {
      return failure(
        VALIDATION_CODES.PERSONAL_EXCEEDS_TOTAL,
        "a personal amount cannot exceed the total",
      );
    }
    personalSum += participant.personalMinor;
  }
  if (personalSum > input.totalMinor) {
    return failure(
      VALIDATION_CODES.PERSONAL_SUM_EXCEEDS_TOTAL,
      "personal amounts sum to more than the total",
    );
  }

  if (!input.memberIds.includes(input.payerMemberId)) {
    return failure(
      VALIDATION_CODES.PAYER_NOT_MEMBER,
      "the payer must be an event member",
    );
  }

  if (input.mode === "percentage") {
    let basisPointsSum = 0;
    for (const participant of input.participants) {
      if (participant.splitBp === undefined) {
        return failure(
          VALIDATION_CODES.BP_REQUIRED,
          "every participant needs basis points in percentage mode",
        );
      }
      if (
        !isIntegerMinor(participant.splitBp) ||
        participant.splitBp < 0 ||
        participant.splitBp > BP_TOTAL
      ) {
        return failure(
          VALIDATION_CODES.BP_OUT_OF_RANGE,
          "basis points must be integers between 0 and 10000",
        );
      }
      basisPointsSum += participant.splitBp;
    }
    if (basisPointsSum !== BP_TOTAL) {
      return failure(
        VALIDATION_CODES.PCT_SUM_INVALID,
        "basis points must sum to exactly 10000",
      );
    }
  }

  return { ok: true };
}

function failure(code: ValidationErrorCode, message: string): ValidationResult {
  return { ok: false, code, message };
}
