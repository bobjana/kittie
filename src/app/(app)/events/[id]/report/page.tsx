import { notFound, redirect } from "next/navigation";
import { DeliveryStatus } from "@/components/report/delivery-status";
import { EventSwitcher } from "@/components/report/event-switcher";
import { ReportView } from "@/components/report/report-view";
import { SettlementActions } from "@/components/report/settlement-actions";
import { FabLink } from "@/components/ui/fab";
import { AuthorizationError } from "@/lib/authorization";
import { listEventsForUser } from "@/services/events";
import { getEventReport } from "@/services/reports";

export const metadata = { title: "Report" };

// Membership is checked at request time and a non-member must get a real 404
// status, so this route blocks instead of streaming a shell first.
export const instant = false;

export default async function EventReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let report: Awaited<ReturnType<typeof getEventReport>>;
  try {
    report = await getEventReport(id);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.status === 401) redirect("/login");
      if (error.status === 404) notFound();
    }
    throw error;
  }

  const events = await listEventsForUser();
  const viewer = report.members.find(
    (member) => member.memberId === report.viewerMemberId,
  );

  return (
    <div className="mx-auto max-w-2xl">
      <ReportView
        report={report}
        switcher={
          <EventSwitcher events={events} currentEventId={report.event.id} />
        }
        actions={
          <SettlementActions
            eventId={report.event.id}
            status={report.event.status}
            isOrganizer={viewer?.role === "organizer"}
          />
        }
      />
      {report.event.status === "closed" &&
      report.settlementId !== null &&
      viewer?.role === "organizer" ? (
        <DeliveryStatus
          eventId={report.event.id}
          settlementId={report.settlementId}
        />
      ) : null}
      {report.event.status === "open" ? (
        <FabLink
          href={`/events/${report.event.id}/expenses/new`}
          aria-label="Add expense"
        >
          +
        </FabLink>
      ) : null}
    </div>
  );
}
