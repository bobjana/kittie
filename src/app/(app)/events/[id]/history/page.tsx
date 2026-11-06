import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { HistoryList } from "@/components/history/history-list";
import { EmptyState } from "@/components/ui";
import { AuthorizationError } from "@/lib/authorization";
import { getEventHistory } from "@/services/audit";

export const metadata = { title: "History" };

// Membership is checked at request time and a non-member must get a real 404
// status, so this route blocks instead of streaming a shell first.
export const instant = false;

export default async function EventHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let history: Awaited<ReturnType<typeof getEventHistory>>;
  try {
    history = await getEventHistory(id);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.status === 401) redirect("/login");
      if (error.status === 404) notFound();
    }
    throw error;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            {history.event.name}
          </h1>
          <p className="text-base text-muted">
            History · {history.event.currency}
          </p>
        </div>
        <Link
          href={`/events/${history.event.id}`}
          className="inline-flex min-h-control items-center rounded-pill border border-border bg-surface px-4 text-base font-semibold text-ink transition-colors hover:bg-lavender"
        >
          Back to event
        </Link>
      </header>

      {history.entries.length === 0 ? (
        <EmptyState
          title="No history yet"
          description="Expenses, personal amounts, invites and close/reopen actions will appear here."
        />
      ) : (
        <HistoryList entries={history.entries} />
      )}
    </div>
  );
}
