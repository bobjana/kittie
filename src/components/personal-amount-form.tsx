"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, CurrencyInput } from "@/components/ui";

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
};

export interface PersonalAmountFormProps {
  expenseId: string;
  currency: string;
  currentPersonalMinor: number;
  /** Upper bound for this member: total - sum of other personal amounts. */
  personalBoundMinor: number;
}

export function PersonalAmountForm({
  expenseId,
  currency,
  currentPersonalMinor,
  personalBoundMinor,
}: PersonalAmountFormProps) {
  const router = useRouter();
  const [amountText, setAmountText] = useState(() =>
    formatDecimal(currentPersonalMinor),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const parsed = parseMinorUnits(amountText);
  const amountError =
    parsed === null
      ? "Enter a valid amount"
      : parsed < 0
        ? "The personal amount cannot be negative"
        : parsed > personalBoundMinor
          ? `Your personal amount can't be more than ${formatDecimal(personalBoundMinor)}`
          : undefined;

  async function handleSave() {
    if (parsed === null || amountError !== undefined) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/expenses/${expenseId}/personal`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personalMinor: parsed }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        setError(data.message ?? "Could not save your personal amount.");
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <CurrencyInput
        label="Your personal amount"
        value={amountText}
        onChange={(event) => setAmountText(event.target.value)}
        error={amountError}
        currencySymbol={CURRENCY_SYMBOLS[currency] ?? currency}
      />
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={parsed === null || amountError !== undefined || submitting}
        >
          {submitting ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setAmountText(formatDecimal(currentPersonalMinor))}
        >
          Reset
        </Button>
      </div>
    </form>
  );
}

function parseMinorUnits(text: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return null;
  }
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}

function formatDecimal(minor: number): string {
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const fraction = `${abs % 100}`.padStart(2, "0");
  return minor < 0 ? `-${whole}.${fraction}` : `${whole}.${fraction}`;
}
