import Link from "next/link";
import { redirect } from "next/navigation";
import { ReportView } from "@/components/report/report-view";
import { TallyLanding } from "@/components/report/tally-landing";
import { EmptyState } from "@/components/ui";
import { AuthorizationError } from "@/lib/authorization";
import {
  getEventReport,
  listTallyEvents,
  resolveTallyLanding,
  type TallyEventCard,
} from "@/services/reports";

export const metadata = { title: "Tally" };

// The landing decision reads the session and event rows at request time and
// must block so a single open event redirects with a real HTTP 307.
export const instant = false;

const primaryLinkClass =
  "inline-flex min-h-control items-center rounded-pill bg-accent px-5 text-base font-semibold text-white shadow-soft transition-colors hover:bg-accent-strong";

export default async function TallyPage() {
  let events: TallyEventCard[];
  try {
    events = await listTallyEvents();
  } catch (error) {
    if (error instanceof AuthorizationError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  const decision = resolveTallyLanding(events);

  if (decision.kind === "redirect") {
    redirect(`/events/${decision.eventId}/report`);
  }

  const content = await renderDecision(decision);

  return <div className="mx-auto max-w-2xl">{content}</div>;
}

async function renderDecision(
  decision: Exclude<
    ReturnType<typeof resolveTallyLanding>,
    { kind: "redirect" }
  >,
) {
  if (decision.kind === "closed") {
    const report = await getEventReport(decision.eventId);
    return (
      <div className="flex flex-col gap-4">
        <p className="text-base text-muted">
          All your events are settled - here is the most recent final tally.
        </p>
        <ReportView report={report} />
      </div>
    );
  }

  if (decision.kind === "empty") {
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
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">
          Tally
        </h1>
        <p className="text-base text-muted">
          Pick an event to see who owes whom
        </p>
      </header>
      <TallyLanding openEvents={decision.events} />
    </div>
  );
}
