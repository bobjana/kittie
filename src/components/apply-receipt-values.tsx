"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Amount, Button } from "@/components/ui";
import {
  type OcrJobValues,
  useOcrJobPoll,
} from "@/components/use-ocr-job-poll";

export interface ApplyReceiptValuesProps {
  expenseId: string;
  version: number;
  eventCurrency: string;
  currentTotalMinor: number;
  currentSpentOn: string;
  currentDescription: string | null;
  job: {
    jobId: string;
    status: string;
    result: OcrJobValues | null;
  };
}

/**
 * The capturer's "Apply receipt values" action (row 17): an expense saved
 * before OCR finished keeps its receipt, and the parsed amount, date and
 * merchant can still be applied from the detail page while the event is open.
 * A currency mismatch never applies the amount - only the date and merchant.
 * The expense PATCH is version-checked by row 13, so a stale page cannot
 * silently overwrite a concurrent edit.
 */
export function ApplyReceiptValues({
  expenseId,
  version,
  eventCurrency,
  currentTotalMinor,
  currentSpentOn,
  currentDescription,
  job,
}: ApplyReceiptValuesProps) {
  const router = useRouter();
  const terminal = job.status === "succeeded" || job.status === "failed";
  const poll = useOcrJobPoll({ jobId: terminal ? null : job.jobId });
  const status = terminal ? job.status : poll.status;
  const result = job.result ?? poll.result;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  if (status === "idle" || status === "pending") {
    return (
      <div className="mt-4 border-t border-border pt-4">
        <p aria-live="polite" className="text-sm text-muted">
          Reading the receipt values…
        </p>
      </div>
    );
  }

  if (result === null) {
    return (
      <div className="mt-4 border-t border-border pt-4">
        <p className="text-sm text-muted">
          We couldn't read this receipt - edit the expense manually.
        </p>
      </div>
    );
  }

  const merchant = result.merchant.trim().slice(0, 120);
  const amountAppliable = !result.currencyMismatch;
  const amountDiffers =
    amountAppliable && result.amountMinor !== currentTotalMinor;
  const dateDiffers = result.date !== "" && result.date !== currentSpentOn;
  const merchantDiffers =
    merchant !== "" && merchant !== (currentDescription ?? "");
  const needsApply =
    !applied && (amountDiffers || dateDiffers || merchantDiffers);

  async function applyValues() {
    if (result === null) {
      return;
    }
    setSubmitting(true);
    setError(null);
    const body: Record<string, unknown> = { version };
    if (amountAppliable) {
      body.totalMinor = result.amountMinor;
    }
    if (result.date !== "") {
      body.spentOn = result.date;
    }
    if (merchant !== "") {
      body.description = merchant;
    }
    try {
      const response = await fetch(`/api/expenses/${expenseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = (await response.json()) as { message?: string };
        setError(data.message ?? "Could not apply the receipt values.");
        return;
      }
      setApplied(true);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
      <p className="text-sm font-bold text-ink">Receipt values</p>
      <ul className="flex flex-col gap-1 text-sm text-muted">
        {amountAppliable ? (
          <li>
            Amount:{" "}
            <Amount
              minorUnits={result.amountMinor}
              currency={eventCurrency}
              size="sm"
            />
          </li>
        ) : null}
        {result.date !== "" ? <li>Date: {result.date}</li> : null}
        {merchant !== "" ? <li>Merchant: {merchant}</li> : null}
      </ul>
      {result.currencyMismatch ? (
        <p className="text-sm text-muted">
          Receipt is in {result.currency}; enter the event-currency amount
          yourself.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      {needsApply ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void applyValues();
            }}
            loading={submitting}
          >
            Apply receipt values
          </Button>
        </div>
      ) : (
        <p className="text-sm font-semibold text-success">
          These values are already on the expense.
        </p>
      )}
    </div>
  );
}
