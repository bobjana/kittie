import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { ExpenseForm } from "@/components/expense-form";
import { Skeleton } from "@/components/ui";
import { AuthorizationError } from "@/lib/authorization";
import { getNewExpenseData, type NewExpenseData } from "@/services/expenses";

export default function NewExpensePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="mx-auto max-w-xl">
      <Suspense fallback={<FormSkeleton />}>
        <NewExpenseContent params={params} />
      </Suspense>
    </div>
  );
}

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-96" />
    </div>
  );
}

async function NewExpenseContent({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let data: NewExpenseData;
  try {
    data = await getNewExpenseData(id);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.status === 401) redirect("/login");
      if (error.status === 404) notFound();
    }
    throw error;
  }

  if (data.event.status === "closed") {
    redirect(`/events/${id}`);
  }

  return (
    <>
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            Add expense
          </h1>
          <p className="text-base text-muted">{data.event.name}</p>
        </div>
        <Link
          href={`/events/${id}`}
          className="inline-flex min-h-control items-center rounded-pill border border-border bg-surface px-4 text-base font-semibold text-ink transition-colors hover:bg-lavender"
        >
          Cancel
        </Link>
      </header>

      <ExpenseForm
        eventId={id}
        currency={data.event.currency}
        members={data.members}
        currentMemberId={data.currentMemberId}
      />
    </>
  );
}
