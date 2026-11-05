"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  type ParticipantOption,
  ParticipantPicker,
  participantName,
} from "@/components/participant-picker";
import {
  Button,
  Card,
  CurrencyInput,
  Input,
  PercentageInput,
} from "@/components/ui";

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
};

export interface EditableParticipant {
  memberId: string;
  splitBp: number | null;
  personalMinor: number;
}

export interface ExpenseEditFormProps {
  eventId: string;
  expenseId: string;
  currency: string;
  version: number;
  members: ParticipantOption[];
  initial: {
    totalMinor: number;
    spentOn: string;
    description: string;
    paidByMemberId: string;
    splitMode: "equal" | "percentage";
    participants: EditableParticipant[];
  };
}

type SplitMode = "equal" | "percentage";

export function ExpenseEditForm({
  eventId,
  expenseId,
  currency,
  version,
  members,
  initial,
}: ExpenseEditFormProps) {
  const router = useRouter();
  const [amountText, setAmountText] = useState(
    formatDecimal(initial.totalMinor),
  );
  const [spentOn, setSpentOn] = useState(initial.spentOn);
  const [description, setDescription] = useState(initial.description);
  const [paidByMemberId, setPaidByMemberId] = useState(initial.paidByMemberId);
  const [splitMode, setSplitMode] = useState<SplitMode>(initial.splitMode);
  const [selectedIds, setSelectedIds] = useState<string[]>(
    initial.participants.map((participant) => participant.memberId),
  );
  const [percentages, setPercentages] = useState<Record<string, string>>(() => {
    const initialPercentages: Record<string, string> = {};
    for (const participant of initial.participants) {
      if (participant.splitBp !== null) {
        initialPercentages[participant.memberId] = formatBp(
          participant.splitBp,
        );
      }
    }
    return initialPercentages;
  });
  const [serverError, setServerError] = useState<string | null>(null);
  const [staleVersion, setStaleVersion] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const totalMinor = parseMinorUnits(amountText);
  const amountError =
    totalMinor === null
      ? "Enter a valid amount"
      : totalMinor <= 0
        ? "The amount must be greater than zero"
        : undefined;

  const descriptionError =
    description.length > 120 ? "120 characters or fewer" : undefined;

  const basisPoints: Record<string, number | null> = {};
  for (const id of selectedIds) {
    basisPoints[id] = parseBasisPoints(percentages[id] ?? "");
  }
  const pctSum = selectedIds.reduce(
    (sum, id) => sum + (basisPoints[id] ?? 0),
    0,
  );
  const pctReady =
    splitMode !== "percentage" ||
    (selectedIds.every((id) => basisPoints[id] !== null) && pctSum === 10000);

  const canSave =
    totalMinor !== null &&
    amountError === undefined &&
    descriptionError === undefined &&
    selectedIds.length > 0 &&
    pctReady &&
    !submitting;

  async function handleSave() {
    if (!canSave || totalMinor === null) {
      return;
    }
    setSubmitting(true);
    setServerError(null);
    setStaleVersion(false);
    try {
      const participants = selectedIds.map((memberId) => ({
        memberId,
        ...(splitMode === "percentage"
          ? { splitBp: basisPoints[memberId] ?? 0 }
          : {}),
      }));
      const response = await fetch(`/api/expenses/${expenseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version,
          totalMinor,
          spentOn: spentOn || null,
          description: description.trim() || null,
          paidByMemberId,
          splitMode,
          participants,
        }),
      });
      if (response.status === 409) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        if (data.error === "STALE_EXPENSE") {
          setStaleVersion(true);
          setServerError(
            "This expense changed since you opened the editor. Reload the page and apply your changes again.",
          );
        } else {
          setServerError(data.message ?? "Could not save the expense.");
        }
        return;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        setServerError(data.message ?? "Could not save the expense.");
        return;
      }
      router.push(`/events/${eventId}/expenses/${expenseId}`);
      router.refresh();
    } catch {
      setServerError("Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSave();
        }}
        noValidate
      >
        <CurrencyInput
          label="Amount"
          value={amountText}
          onChange={(event) => setAmountText(event.target.value)}
          error={amountError}
          currencySymbol={CURRENCY_SYMBOLS[currency] ?? currency}
        />

        <Input
          label="Date"
          type="date"
          value={spentOn}
          onChange={(event) => setSpentOn(event.target.value)}
        />

        <Input
          label="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          error={descriptionError}
          hint="Optional"
        />

        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-ink">Paid by</span>
          <select
            className="min-h-control rounded-input border border-border bg-surface px-3 text-base text-ink"
            value={paidByMemberId}
            onChange={(event) => setPaidByMemberId(event.target.value)}
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {participantName(member)}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-ink">Split</legend>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={splitMode === "equal" ? "primary" : "secondary"}
              aria-pressed={splitMode === "equal"}
              onClick={() => setSplitMode("equal")}
            >
              Equally
            </Button>
            <Button
              type="button"
              variant={splitMode === "percentage" ? "primary" : "secondary"}
              aria-pressed={splitMode === "percentage"}
              onClick={() => setSplitMode("percentage")}
            >
              Percentages
            </Button>
          </div>
        </fieldset>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink">Split between</h2>
          <ParticipantPicker
            members={members}
            selectedIds={selectedIds}
            onChange={setSelectedIds}
          />
          {splitMode === "percentage" ? (
            <div className="flex flex-col gap-2">
              {selectedIds.map((id) => {
                const member = members.find((option) => option.id === id);
                return (
                  <PercentageInput
                    key={id}
                    label={member ? participantName(member) : id}
                    value={percentages[id] ?? ""}
                    onChange={(event) =>
                      setPercentages((previous) => ({
                        ...previous,
                        [id]: event.target.value,
                      }))
                    }
                  />
                );
              })}
              <p className="text-sm text-muted">
                {formatBp(pctSum)}% assigned
                {pctSum === 10000 ? "" : " — must total 100%"}
              </p>
            </div>
          ) : null}
        </section>

        {staleVersion ? (
          <output className="flex items-center gap-3">
            <span className="text-sm font-semibold text-danger">
              {serverError}
            </span>
            <Button
              type="button"
              variant="secondary"
              onClick={() => router.refresh()}
            >
              Reload
            </Button>
          </output>
        ) : serverError ? (
          <p role="alert" className="text-sm font-semibold text-danger">
            {serverError}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button type="submit" disabled={!canSave}>
            {submitting ? "Saving…" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              router.push(`/events/${eventId}/expenses/${expenseId}`)
            }
          >
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function parseMinorUnits(text: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return null;
  }
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}

function parseBasisPoints(text: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return null;
  }
  const [whole, fraction = ""] = text.split(".");
  const bp = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  return bp <= 10000 ? bp : null;
}

function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2).replace(/\.00$/, "")}`;
}

function formatDecimal(minor: number): string {
  const whole = Math.floor(minor / 100);
  const fraction = `${minor % 100}`.padStart(2, "0");
  return `${whole}.${fraction}`;
}
