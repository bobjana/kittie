"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useRef, useState } from "react";
import {
  type ParticipantOption,
  ParticipantPicker,
  participantName,
} from "@/components/participant-picker";
import {
  ReceiptCapture,
  type ReceiptCapturePhase,
  type ReceiptCaptureStatus,
  type ReceiptUploadResult,
  receiptCaptureErrorMessage,
} from "@/components/receipt-capture";
import { SplitEditor } from "@/components/split-editor";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  CurrencyInput,
  Input,
} from "@/components/ui";
import {
  type OcrJobValues as OcrResultJson,
  useOcrJobPoll,
} from "@/components/use-ocr-job-poll";
import { summarizePercentages } from "@/domain/percentage";

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  JPY: "¥",
  CHF: "CHF",
  SEK: "kr",
  NOK: "kr",
  DKK: "kr",
  PLN: "zł",
  CZK: "Kč",
  CAD: "$",
  AUD: "$",
  NZD: "$",
  ZAR: "R",
  BRL: "R$",
  MXN: "$",
};

export interface ExpenseFormProps {
  eventId: string;
  currency: string;
  members: ParticipantOption[];
  currentMemberId: string;
}

type SplitMode = "equal" | "percentage";

const REVIEW_BANNER_TEXT = "Check the receipt values";
const OCR_FAILURE_TEXT = "Couldn't read it - enter manually";

type OcrChipState =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "reading" }
  | { kind: "succeeded"; result: OcrResultJson }
  | { kind: "failed" };

function formatMinorForInput(minor: number): string {
  return (minor / 100).toFixed(2);
}

export function ExpenseForm({
  eventId,
  currency,
  members,
  currentMemberId,
}: ExpenseFormProps) {
  const router = useRouter();
  const [amountText, setAmountText] = useState("");
  const [spentOn, setSpentOn] = useState(todayLocal());
  const [description, setDescription] = useState("");
  const [paidByMemberId, setPaidByMemberId] = useState(currentMemberId);
  const [splitMode, setSplitMode] = useState<SplitMode>("equal");
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    members.map((member) => member.id),
  );
  const [personalText, setPersonalText] = useState("");
  const [percentages, setPercentages] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ---- Row 17: receipt capture and OCR review --------------------------------
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [ocrJobId, setOcrJobId] = useState<string | null>(null);
  const [capturePhase, setCapturePhase] = useState<ReceiptCapturePhase>("idle");
  const [uploadErrorCode, setUploadErrorCode] = useState<string | null>(null);
  // Dirty flags are refs: the prefill decision reads them synchronously when
  // the poll resolves, without re-rendering on every keystroke.
  const amountDirtyRef = useRef(false);
  const dateDirtyRef = useRef(false);
  const descriptionDirtyRef = useRef(false);

  // Prefill only fields the user has not touched: a typed value always wins.
  const applyOcrValues = useCallback((result: OcrResultJson) => {
    if (!result.currencyMismatch && !amountDirtyRef.current) {
      setAmountText(formatMinorForInput(result.amountMinor));
    }
    if (result.date !== "" && !dateDirtyRef.current) {
      setSpentOn(result.date);
    }
    const merchant = result.merchant.trim().slice(0, 120);
    if (merchant !== "" && !descriptionDirtyRef.current) {
      setDescription(merchant);
    }
  }, []);

  const ocr = useOcrJobPoll({ jobId: ocrJobId, onResult: applyOcrValues });

  const ocrChip: OcrChipState =
    capturePhase === "busy"
      ? { kind: "uploading" }
      : ocr.status === "pending"
        ? { kind: "reading" }
        : ocr.status === "succeeded" && ocr.result
          ? { kind: "succeeded", result: ocr.result }
          : ocr.status === "failed"
            ? { kind: "failed" }
            : { kind: "idle" };

  const handleCaptureStatus = useCallback((status: ReceiptCaptureStatus) => {
    setCapturePhase(status.phase);
    if (status.phase === "busy") {
      setUploadErrorCode(null);
    } else if (status.phase === "error") {
      setUploadErrorCode(status.errorCode ?? "UPLOAD_FAILED");
      setOcrJobId(null);
    }
  }, []);

  const handleReceiptUploaded = useCallback((result: ReceiptUploadResult) => {
    setReceiptId(result.receiptId);
    setUploadErrorCode(null);
    setOcrJobId(result.ocr.jobId ?? null);
  }, []);

  const amountEmpty = amountText.trim() === "";
  const totalMinor = amountEmpty ? null : parseMinorUnits(amountText);
  const amountError = amountEmpty
    ? "Enter an amount"
    : totalMinor === null
      ? "Enter a valid amount"
      : totalMinor <= 0
        ? "Enter an amount greater than zero"
        : undefined;

  const personalEmpty = personalText.trim() === "";
  const personalMinor = personalEmpty ? 0 : parseMinorUnits(personalText);
  const personalError =
    !personalEmpty && personalMinor === null
      ? "Enter a valid amount"
      : personalMinor !== null &&
          totalMinor !== null &&
          personalMinor > totalMinor
        ? "Your personal amount can't be more than the total"
        : undefined;

  const descriptionError =
    description.trim().length > 120 ? "120 characters or fewer" : undefined;
  const participantsError =
    selectedIds.length === 0 ? "Select at least one person" : undefined;

  const pctSummary = summarizePercentages(selectedIds, percentages);
  const pctReady = pctSummary.ready;

  const canSave =
    !amountError &&
    totalMinor !== null &&
    !personalError &&
    !descriptionError &&
    !participantsError &&
    (splitMode === "equal" || pctReady) &&
    !submitting;

  const creatorSelected = selectedIds.includes(currentMemberId);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError(null);
    if (!canSave || totalMinor === null) {
      return;
    }
    // The gate is enforced again in the submit path itself: the disabled Save
    // button is only the affordance, never the enforcement.
    if (splitMode === "percentage" && !pctReady) {
      return;
    }

    const participants = selectedIds.map((id) => ({
      memberId: id,
      ...(splitMode === "percentage"
        ? { splitBp: pctSummary.states[id]?.bp ?? 0 }
        : {}),
      ...(splitMode === "equal" && id === currentMemberId
        ? { personalMinor }
        : {}),
    }));

    setSubmitting(true);
    try {
      const response = await fetch(`/api/events/${eventId}/expenses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          totalMinor,
          spentOn: spentOn || null,
          description: description.trim() || null,
          paidByMemberId,
          splitMode,
          participants,
          ...(receiptId ? { receiptId } : {}),
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };

      if (!response.ok) {
        if (response.status === 401) {
          router.push("/login");
          return;
        }
        setServerError(
          data.message ?? data.error ?? "Could not add the expense.",
        );
        return;
      }

      router.push(`/events/${eventId}`);
      router.refresh();
    } catch {
      setServerError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
        <CurrencyInput
          label="Amount"
          value={amountText}
          onChange={(event) => {
            amountDirtyRef.current = true;
            setAmountText(event.target.value);
          }}
          error={amountError}
          autoFocus
          currencySymbol={currencySymbol(currency)}
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-ink">Split</legend>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={splitMode === "equal" ? "primary" : "secondary"}
              onClick={() => setSplitMode("equal")}
              aria-pressed={splitMode === "equal"}
            >
              Equally
            </Button>
            <Button
              type="button"
              variant={splitMode === "percentage" ? "primary" : "secondary"}
              onClick={() => setSplitMode("percentage")}
              aria-pressed={splitMode === "percentage"}
            >
              Percentages
            </Button>
          </div>
        </fieldset>

        <section className="flex flex-col gap-3">
          <CardTitle as="h2">Split between</CardTitle>
          <ParticipantPicker
            members={members}
            selectedIds={selectedIds}
            onChange={setSelectedIds}
          />
          {participantsError ? (
            <p role="alert" className="text-sm font-semibold text-danger">
              {participantsError}
            </p>
          ) : null}
        </section>

        {splitMode === "equal" && creatorSelected ? (
          <CurrencyInput
            label="Your personal amount"
            hint="Optional. Carved out of the total before it is split."
            value={personalText}
            onChange={(event) => setPersonalText(event.target.value)}
            error={personalError}
            currencySymbol={currencySymbol(currency)}
          />
        ) : null}

        {splitMode === "percentage" ? (
          <SplitEditor
            members={members
              .filter((member) => selectedIds.includes(member.id))
              .map((member) => ({
                id: member.id,
                name: participantName(member),
              }))}
            totalMinor={totalMinor}
            currency={currency}
            values={percentages}
            onChange={setPercentages}
          />
        ) : null}

        <div className="flex flex-col">
          <label
            htmlFor="paid-by"
            className="mb-1.5 text-sm font-semibold text-ink"
          >
            Paid by
          </label>
          <select
            id="paid-by"
            value={paidByMemberId}
            onChange={(event) => setPaidByMemberId(event.target.value)}
            className="min-h-control rounded-input border border-border bg-surface px-4 text-base font-semibold text-ink transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {participantName(member)}
              </option>
            ))}
          </select>
        </div>

        <Input
          label="Date"
          type="date"
          value={spentOn}
          onChange={(event) => {
            dateDirtyRef.current = true;
            setSpentOn(event.target.value);
          }}
        />

        <Input
          label="Description"
          value={description}
          onChange={(event) => {
            descriptionDirtyRef.current = true;
            setDescription(event.target.value);
          }}
          error={descriptionError}
          hint="Optional"
          placeholder="Dinner at the marina"
        />

        <ReceiptSection
          eventId={eventId}
          currency={currency}
          receiptId={receiptId}
          chip={ocrChip}
          uploadErrorCode={uploadErrorCode}
          disabled={submitting}
          onUploaded={handleReceiptUploaded}
          onStatusChange={handleCaptureStatus}
        />

        {serverError ? (
          <p role="alert" className="text-sm font-semibold text-danger">
            {serverError}
          </p>
        ) : null}

        <Button
          type="submit"
          size="lg"
          fullWidth
          disabled={!canSave}
          loading={submitting}
        >
          Save expense
        </Button>
      </form>
    </Card>
  );
}

interface ChipView {
  label: string;
  tone: "neutral" | "success" | "danger";
}

function chipViewFor(chip: OcrChipState): ChipView | null {
  switch (chip.kind) {
    case "uploading":
      return { label: "Uploading receipt…", tone: "neutral" };
    case "reading":
      return { label: "Reading the receipt…", tone: "neutral" };
    case "succeeded":
      return { label: "Receipt read.", tone: "success" };
    case "failed":
      return { label: "Couldn't read the receipt.", tone: "danger" };
    default:
      return null;
  }
}

/**
 * Receipt capture plus the OCR status chip and review banner. The chip is
 * non-blocking by construction: it never touches Save, and the capture's own
 * status line is suppressed so only one live region speaks.
 */
function ReceiptSection({
  eventId,
  currency,
  receiptId,
  chip,
  uploadErrorCode,
  disabled,
  onUploaded,
  onStatusChange,
}: {
  eventId: string;
  currency: string;
  receiptId: string | null;
  chip: OcrChipState;
  uploadErrorCode: string | null;
  disabled: boolean;
  onUploaded: (result: ReceiptUploadResult) => void;
  onStatusChange: (status: ReceiptCaptureStatus) => void;
}) {
  const chipView = chipViewFor(chip);
  const result = chip.kind === "succeeded" ? chip.result : null;

  return (
    <section className="flex flex-col gap-3">
      <CardTitle as="h2">Receipt</CardTitle>
      <ReceiptCapture
        eventId={eventId}
        disabled={disabled}
        showStatus={false}
        onUploaded={onUploaded}
        onStatusChange={onStatusChange}
      />
      <div aria-live="polite" className="flex flex-col gap-2">
        {chipView ? (
          <div className="flex">
            <Badge tone={chipView.tone}>{chipView.label}</Badge>
          </div>
        ) : null}
        {result ? (
          <div className="rounded-input border border-accent/30 bg-lavender px-4 py-3">
            <p className="text-sm font-bold text-accent-strong">
              {REVIEW_BANNER_TEXT}
            </p>
            {result.currencyMismatch ? (
              <p className="mt-1 text-sm text-accent-strong">
                Receipt is in {result.currency}; enter the event-currency amount
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted">
                We filled in what we could read - check it against the receipt
                before saving.
              </p>
            )}
          </div>
        ) : null}
        {chip.kind === "failed" ? (
          <div className="rounded-input border border-danger/30 bg-danger/5 px-4 py-3">
            <p className="text-sm font-semibold text-danger">
              {OCR_FAILURE_TEXT}
            </p>
          </div>
        ) : null}
        {uploadErrorCode ? (
          <p role="alert" className="text-sm font-semibold text-danger">
            {receiptCaptureErrorMessage(uploadErrorCode)}
          </p>
        ) : null}
        {receiptId ? (
          <p className="text-sm text-muted">
            The receipt is attached and will be saved with this expense (
            {currency}).
          </p>
        ) : null}
      </div>
    </section>
  );
}

function parseMinorUnits(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const minor = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  return Number.isSafeInteger(minor) ? minor : null;
}

function todayLocal(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code] ?? code;
}
