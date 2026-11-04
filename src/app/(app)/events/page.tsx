import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Badge, Card, cx, EmptyState, Skeleton } from "@/components/ui";
import { AuthorizationError } from "@/lib/authorization";
import { type EventSummary, listEventsForUser } from "@/services/events";

export const metadata = { title: "Events" };

const primaryLinkClass = cx(
  "inline-flex min-h-control items-center justify-center gap-2 rounded-pill",
  "bg-accent px-5 text-base font-semibold text-white shadow-soft",
  "transition-colors hover:bg-accent-strong",
);

export default function EventsPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            Events
          </h1>
          <p className="text-base text-muted">Your trips and dinners</p>
        </div>
        <Link href="/events/new" className={primaryLinkClass}>
          New event
        </Link>
      </header>

      <Suspense fallback={<EventsSkeleton />}>
        <EventsList />
      </Suspense>
    </div>
  );
}

function EventsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
    </div>
  );
}

async function EventsList() {
  let events: EventSummary[];
  try {
    events = await listEventsForUser();
  } catch (error) {
    if (error instanceof AuthorizationError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  if (events.length === 0) {
    return (
      <EmptyState
        title="No events yet"
        description="Create your first event to start splitting expenses with friends."
        action={
          <Link href="/events/new" className={primaryLinkClass}>
            Create an event
          </Link>
        }
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {events.map((event) => (
        <li key={event.id}>
          <Link href={`/events/${event.id}`} className="block">
            <Card className="transition-transform hover:-translate-y-0.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-lg font-bold text-ink">
                    {event.name}
                  </p>
                  <p className="text-base text-muted">
                    {formatEventMeta(event)}
                  </p>
                </div>
                <Badge tone={event.status === "open" ? "success" : "neutral"}>
                  {event.status === "open" ? "Open" : "Closed"}
                </Badge>
              </div>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function formatEventMeta(event: EventSummary): string {
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
