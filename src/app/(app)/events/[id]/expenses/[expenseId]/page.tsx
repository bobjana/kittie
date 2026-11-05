import Link from "next/link";
import { notFound } from "next/navigation";
import { ApplyReceiptValues } from "@/components/apply-receipt-values";
import { PersonalAmountForm } from "@/components/personal-amount-form";
import {
  Amount,
  Avatar,
  Badge,
  Button,
  Card,
  CardText,
  CardTitle,
} from "@/components/ui";
import { VoidExpenseButton } from "@/components/void-expense-button";
import { requireSession } from "@/lib/authorization";
import { getExpenseDetail } from "@/services/expenses";

interface PageProps {
  params: Promise<{ id: string; expenseId: string }>;
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatAuditTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function ExpenseDetailPage({ params }: PageProps) {
  const { id, expenseId } = await params;
  await requireSession();

  let detail: Awaited<ReturnType<typeof getExpenseDetail>>;
  try {
    detail = await getExpenseDetail(id, expenseId);
  } catch {
    notFound();
  }

  const { expense, event, participants, audit, receiptId } = detail;
  const voided = expense.status === "voided";
  const closed = event.status === "closed";
  const editable = !voided && !closed && detail.isCapturer;

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex items-center gap-2 text-sm text-muted">
        <Link
          href={`/events/${id}`}
          className="underline-offset-2 hover:underline"
        >
          {event.name}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-ink">Expense</span>
      </nav>

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <CardTitle>{expense.description ?? "Expense"}</CardTitle>
              {voided ? <Badge tone="danger">Voided</Badge> : null}
            </div>
            <CardText>
              {formatDate(expense.spentOn)}
              {expense.paidByMemberId ? (
                <>
                  {" "}
                  · paid by{" "}
                  {participants.find(
                    (row) => row.memberId === expense.paidByMemberId,
                  )?.displayName ?? "a member"}
                </>
              ) : null}
              {" · "}
              {expense.splitMode === "percentage" ? "percentage" : "equal"}{" "}
              split
            </CardText>
          </div>
          <Amount
            minorUnits={expense.totalMinor}
            currency={event.currency}
            size="xl"
            tone={voided ? "muted" : "default"}
          />
        </div>

        {voided && expense.voidReason ? (
          <div className="mt-4 rounded-input border border-danger/30 bg-danger/5 px-4 py-3">
            <p className="text-sm font-semibold text-danger">
              Voided: {expense.voidReason}
            </p>
          </div>
        ) : null}

        {editable ? (
          <div className="mt-4 flex gap-2">
            <Link
              href={`/events/${id}/expenses/${expense.id}/edit`}
              className="inline-flex"
            >
              <Button type="button" variant="secondary">
                Edit expense
              </Button>
            </Link>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardTitle as="h2">Participants</CardTitle>
        <ul className="flex flex-col divide-y divide-border">
          {participants.map((participant) => (
            <li
              key={participant.memberId}
              className="flex items-center gap-3 py-3"
            >
              <Avatar
                name={participant.displayName ?? participant.memberId}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-ink">
                  {participant.displayName ?? participant.memberId}
                  {participant.memberId === detail.currentMemberId ? (
                    <span className="text-muted"> (you)</span>
                  ) : null}
                </p>
                {participant.personalMinor > 0 ? (
                  <p className="text-sm text-muted">
                    Personal:{" "}
                    <Amount
                      minorUnits={participant.personalMinor}
                      currency={event.currency}
                      size="sm"
                      tone="muted"
                    />
                  </p>
                ) : null}
              </div>
              <Amount
                minorUnits={participant.shareMinor}
                currency={event.currency}
                size="md"
              />
            </li>
          ))}
        </ul>
      </Card>

      {detail.yourPersonalMinor !== null && !voided && !closed ? (
        <Card>
          <CardTitle as="h2">Your personal amount</CardTitle>
          <CardText>
            You can adjust your own personal contribution for this expense. Your
            amount can be up to{" "}
            <Amount
              minorUnits={detail.yourPersonalBoundMinor ?? 0}
              currency={event.currency}
              size="sm"
            />
            .
          </CardText>
          <div className="mt-4">
            <PersonalAmountForm
              expenseId={expense.id}
              currency={event.currency}
              currentPersonalMinor={detail.yourPersonalMinor}
              personalBoundMinor={detail.yourPersonalBoundMinor ?? 0}
            />
          </div>
        </Card>
      ) : null}

      {detail.canVoid && !voided && !closed ? (
        <Card>
          <CardTitle as="h2">Void this expense</CardTitle>
          <CardText>
            Voiding excludes this expense from the tally. The receipt and the
            audit history stay.
          </CardText>
          <div className="mt-4">
            <VoidExpenseButton expenseId={expense.id} />
          </div>
        </Card>
      ) : null}

      {audit.length > 0 ? (
        <Card>
          <CardTitle as="h2">History</CardTitle>
          <ul className="flex flex-col gap-2">
            {audit.map((entry) => (
              <li key={entry.id} className="text-sm text-muted">
                <span className="font-semibold text-ink">
                  {entry.actorName}
                </span>{" "}
                {entry.action.replace(/^expense\./, "")} ·{" "}
                {formatAuditTime(entry.createdAt)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {receiptId ? (
        <Card>
          <CardTitle as="h2">Receipt</CardTitle>
          <CardText>A receipt is attached to this expense.</CardText>
          {editable && detail.receiptOcr ? (
            <ApplyReceiptValues
              expenseId={expense.id}
              version={expense.version}
              eventCurrency={event.currency}
              currentTotalMinor={expense.totalMinor}
              currentSpentOn={expense.spentOn}
              currentDescription={expense.description}
              job={detail.receiptOcr}
            />
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
