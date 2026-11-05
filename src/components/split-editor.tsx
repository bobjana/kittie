"use client";

import { useId } from "react";
import { Amount, PercentageInput } from "@/components/ui";
import {
  formatBasisPoints,
  type PercentSummary,
  summarizePercentages,
} from "@/domain/percentage";
import { computeShares } from "@/domain/split";

export interface SplitEditorMember {
  id: string;
  name: string;
}

export interface SplitEditorProps {
  members: SplitEditorMember[];
  totalMinor: number | null;
  currency: string;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

export function SplitEditor({
  members,
  totalMinor,
  currency,
  values,
  onChange,
}: SplitEditorProps) {
  const headingId = useId();
  const summary = summarizePercentages(
    members.map((member) => member.id),
    values,
  );
  const previewShares = buildPreviewShares(summary, members, totalMinor);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-bold text-ink">
        Percentages
      </h2>
      <ul className="flex flex-col gap-4">
        {members.map((member) => {
          const state = summary.states[member.id] ?? { bp: null };
          const shareMinor = previewShares?.get(member.id);
          return (
            <li key={member.id} className="flex flex-col gap-1">
              <PercentageInput
                label={member.name}
                value={values[member.id] ?? ""}
                onChange={(event) =>
                  onChange({ ...values, [member.id]: event.target.value })
                }
                error={state.error}
              />
              {shareMinor !== undefined ? (
                <p className="text-sm text-muted">
                  Share preview:{" "}
                  <Amount
                    minorUnits={shareMinor}
                    currency={currency}
                    size="sm"
                  />
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <output className="block text-sm font-semibold tabular-nums text-ink">
        {percentIndicator(summary)}
      </output>
    </section>
  );
}

// The preview runs the same domain engine the server stores from, so the
// rounding a person sees here is the rounding that ends up saved.
function buildPreviewShares(
  summary: PercentSummary,
  members: SplitEditorMember[],
  totalMinor: number | null,
): Map<string, number> | null {
  if (!summary.allValid || totalMinor === null || totalMinor <= 0) {
    return null;
  }
  const { shares } = computeShares({
    totalMinor,
    mode: "percentage",
    participants: members.map((member) => ({
      memberId: member.id,
      personalMinor: 0,
      splitBp: summary.states[member.id]?.bp ?? 0,
    })),
  });
  return new Map(shares.map((share) => [share.memberId, share.shareMinor]));
}

function percentIndicator(summary: PercentSummary): string {
  if (!summary.allValid) {
    return "Enter a percentage for each person";
  }
  const total = formatBasisPoints(summary.sumBp);
  if (summary.ready) {
    return `Total ${total}`;
  }
  const side = summary.remainingBp > 0 ? "left" : "over";
  return `Total ${total} / ${formatBasisPoints(Math.abs(summary.remainingBp))} ${side}`;
}
