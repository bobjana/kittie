import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import {
  Amount,
  Avatar,
  Badge,
  Card,
  CardText,
  EmptyState,
  Skeleton,
} from "@/components/ui";
import { AuthorizationError } from "@/lib/authorization";
import { type EventDetail, getEventForMember } from "@/services/events";

export default function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <Suspense fallback={<DetailSkeleton />}>
        <EventDetailContent params={params} />
      </Suspense>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Skeleton className="h-10 w-2/3" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-40" />
    </div>
  );
}

async function EventDetailContent({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let detail: EventDetail;
  try {
    detail = await getEventForMember(id);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.status === 401) redirect("/login");
      if (error.status === 404) notFound();
    }
    throw error;
  }

  const isOpen = detail.event.status === "open";
  const youOwe = detail.yourBalanceMinor > 0;
  const youAreOwed = detail.yourBalanceMinor < 0;

  return (
    <>
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            {detail.event.name}
          </h1>
          <p className="text-base text-muted">
            {formatEventMeta(detail.event)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isOpen ? (
            <Link
              href={`/events/${detail.event.id}/expenses/new`}
              className="inline-flex min-h-control items-center rounded-pill bg-accent px-5 text-base font-semibold text-white shadow-soft transition-colors hover:bg-accent-strong"
            >
              Add expense
            </Link>
          ) : null}
          <Badge tone={isOpen ? "success" : "neutral"}>
            {isOpen ? "Open" : "Closed"}
          </Badge>
        </div>
      </header>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Card>
          <CardText>Group total</CardText>
          <Amount
            minorUnits={detail.totalMinor}
            currency={detail.event.currency}
            size="xl"
          />
        </Card>
        <Card>
          <CardText>Your balance</CardText>
          {detail.yourBalanceMinor === 0 ? (
            <p className="text-4xl font-semibold tabular-nums text-muted">
              Settled up
            </p>
          ) : (
            <Amount
              minorUnits={Math.abs(detail.yourBalanceMinor)}
              currency={detail.event.currency}
              size="xl"
              tone={youOwe ? "danger" : "success"}
            />
          )}
          <p className="text-sm text-muted">
            {youOwe ? "you owe" : youAreOwed ? "you are owed" : null}
          </p>
        </Card>
      </div>

      <section className="mb-6">
        <h2 className="mb-3 text-lg font-bold text-ink">Members</h2>
        <ul className="flex flex-col gap-2">
          {detail.members.map((member) => (
            <li
              key={member.id}
              className="flex items-center gap-3 rounded-input border border-border bg-surface px-4 py-3"
            >
              <Avatar name={member.displayName ?? member.emailNormalized} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-ink">
                  {member.displayName ?? member.emailNormalized}
                </p>
                {member.displayName ? (
                  <p className="truncate text-sm text-muted">
                    {member.emailNormalized}
                  </p>
                ) : null}
              </div>
              {member.role === "organizer" ? (
                <Badge tone="accent">Organizer</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-bold text-ink">Recent expenses</h2>
        {detail.expenses.length === 0 ? (
          <EmptyState
            title="No expenses yet"
            description="Expenses you and your friends add will show up here."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {detail.expenses.map((expense) => (
              <li key={expense.id}>
                <Link
                  href={`/events/${detail.event.id}/expenses/${expense.id}`}
                  className="flex items-center justify-between gap-3 rounded-input border border-border bg-surface px-4 py-3 transition-colors hover:bg-lavender"
                >
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-ink">
                      {expense.description ?? "Expense"}
                    </p>
                    <p className="text-sm text-muted">{expense.spentOn}</p>
                  </div>
                  <Amount
                    minorUnits={expense.totalMinor}
                    currency={expense.currency}
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function formatEventMeta(event: EventDetail["event"]): string {
  const parts: string[] = [];
  if (event.startsOn) parts.push(`from ${formatDate(event.startsOn)}`);
  if (event.endsOn) parts.push(`to ${formatDate(event.endsOn)}`);
  parts.push(event.currency);
  return parts.join(" · ");
}

function formatDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00.000Z`));
}
