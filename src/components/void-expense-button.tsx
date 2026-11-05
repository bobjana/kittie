"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/components/ui";

export interface VoidExpenseButtonProps {
  expenseId: string;
}

export function VoidExpenseButton({ expenseId }: VoidExpenseButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reasonTooLong = reason.trim().length > 200;
  const canSubmit = reason.trim().length > 0 && !reasonTooLong && !submitting;

  async function handleVoid() {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/expenses/${expenseId}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        setError(data.message ?? "Could not void the expense.");
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="danger" onClick={() => setOpen(true)}>
        Void expense
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        id="void-reason"
        label="Why is this expense being voided?"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="e.g. entered the wrong amount"
        aria-invalid={reason.trim() === "" || reasonTooLong ? true : undefined}
      />
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" onClick={handleVoid} disabled={!canSubmit}>
          {submitting ? "Voiding…" : "Confirm void"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setOpen(false);
            setReason("");
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
