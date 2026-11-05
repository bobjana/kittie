import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ExpenseEditForm } from "@/components/expense-edit-form";
import { requireSession } from "@/lib/authorization";
import { getExpenseDetail, getNewExpenseData } from "@/services/expenses";

export default async function EditExpensePage({
  params,
}: {
  params: Promise<{ id: string; expenseId: string }>;
}) {
  const { id, expenseId } = await params;
  await requireSession();

  let detail: Awaited<ReturnType<typeof getExpenseDetail>>;
  let membersData: Awaited<ReturnType<typeof getNewExpenseData>>;
  try {
    detail = await getExpenseDetail(id, expenseId);
    membersData = await getNewExpenseData(id);
  } catch {
    notFound();
  }

  if (
    !detail.isCapturer ||
    detail.event.status === "closed" ||
    detail.expense.status === "voided"
  ) {
    redirect(`/events/${id}/expenses/${expenseId}`);
  }

  return (
    <div className="mx-auto max-w-xl">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            Edit expense
          </h1>
          <p className="text-base text-muted">{detail.event.name}</p>
        </div>
        <Link
          href={`/events/${id}/expenses/${expenseId}`}
          className="inline-flex min-h-control items-center rounded-pill border border-border bg-surface px-4 text-base font-semibold text-ink transition-colors hover:bg-lavender"
        >
          Cancel
        </Link>
      </header>
      <ExpenseEditForm
        eventId={id}
        expenseId={expenseId}
        currency={detail.event.currency}
        version={detail.expense.version}
        members={membersData.members}
        initial={{
          totalMinor: detail.expense.totalMinor,
          spentOn: detail.expense.spentOn,
          description: detail.expense.description ?? "",
          paidByMemberId:
            detail.expense.paidByMemberId ??
            detail.participants[0]?.memberId ??
            detail.currentMemberId,
          splitMode: detail.expense.splitMode,
          participants: detail.participants.map((participant) => ({
            memberId: participant.memberId,
            splitBp: participant.splitBp,
            personalMinor: participant.personalMinor,
          })),
        }}
      />
    </div>
  );
}
