import type { ReactNode } from "react";
import { Amount } from "@/components/ui/amount";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import type { EventReport, ReportMember } from "@/services/reports";

function memberName(report: EventReport, memberId: string): string {
  const member = report.members.find((entry) => entry.memberId === memberId);
  return member ? memberDisplayName(member) : "Removed member";
}

function memberDisplayName(member: ReportMember): string {
  return member.displayName ?? member.emailNormalized;
}

function formatDate(isoDateTime: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDateTime));
}

const netTone = (netMinor: number) =>
  netMinor > 0 ? "success" : netMinor < 0 ? "danger" : "muted";

function MemberRow({
  report,
  member,
}: {
  report: EventReport;
  member: ReportMember;
}) {
  const isViewer = member.memberId === report.viewerMemberId;
  return (
    <li
      className={cx(
        "flex items-center gap-3 rounded-input border border-border bg-surface px-4 py-3",
        isViewer && "border-accent/40",
      )}
    >
      <Avatar name={memberDisplayName(member)} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold text-ink">
          {memberDisplayName(member)}
          {isViewer ? <span className="text-muted"> (you)</span> : null}
        </p>
        <p className="text-sm text-muted">
          paid{" "}
          <Amount
            minorUnits={member.paidMinor}
            currency={report.event.currency}
            size="sm"
          />{" "}
          · share{" "}
          <Amount
            minorUnits={member.shareMinor}
            currency={report.event.currency}
            size="sm"
          />
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm text-muted">net</p>
        {member.netMinor === 0 ? (
          <p className="text-sm font-semibold text-muted">settled</p>
        ) : (
          <Amount
            minorUnits={Math.abs(member.netMinor)}
            currency={report.event.currency}
            size="md"
            tone={netTone(member.netMinor)}
          />
        )}
      </div>
    </li>
  );
}

export function ReportView({
  report,
  switcher,
  actions,
}: {
  report: EventReport;
  switcher?: ReactNode;
  actions?: ReactNode;
}) {
  const isClosed = report.event.status === "closed";
  const viewer = report.members.find(
    (member) => member.memberId === report.viewerMemberId,
  );
  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            {report.event.name}
          </h1>
          <p className="text-base text-muted">{report.event.currency}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {switcher}
          <Badge tone={isClosed ? "neutral" : "success"}>
            {isClosed ? "Closed" : "Open"}
          </Badge>
          {actions}
        </div>
      </header>

      {isClosed && report.event.closedAt ? (
        <p className="rounded-card bg-lavender px-4 py-3 text-base text-ink">
          Final tally - frozen on {formatDate(report.event.closedAt)}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <p className="text-base text-muted">Group total</p>
          <Amount
            minorUnits={report.totalSpentMinor}
            currency={report.event.currency}
            size="xl"
          />
        </Card>
        <Card>
          <p className="text-base text-muted">Your net</p>
          {viewer && viewer.netMinor !== 0 ? (
            <>
              <Amount
                minorUnits={Math.abs(viewer.netMinor)}
                currency={report.event.currency}
                size="xl"
                tone={netTone(viewer.netMinor)}
              />
              <p className="text-base text-muted">
                {viewer.netMinor > 0 ? "you are owed" : "you owe"}
              </p>
            </>
          ) : (
            <p className="text-2xl font-semibold text-ink">Settled up</p>
          )}
        </Card>
      </div>

      <section
        aria-labelledby="settle-up-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="settle-up-heading" className="text-lg font-bold text-ink">
          Who pays whom
        </h2>
        {report.transfers.length === 0 ? (
          <Card>
            <p className="text-base text-muted">
              All settled up - nobody owes anybody.
            </p>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {report.transfers.map((transfer) => (
              <li
                key={`${transfer.fromMemberId}-${transfer.toMemberId}`}
                className="flex flex-wrap items-center gap-2 rounded-input border border-border bg-surface px-4 py-3"
              >
                <span className="text-base font-semibold text-ink">
                  {memberName(report, transfer.fromMemberId)}
                </span>
                <span className="text-base text-muted">pays</span>
                <span className="text-base font-semibold text-ink">
                  {memberName(report, transfer.toMemberId)}
                </span>
                <span className="ml-auto">
                  <Amount
                    minorUnits={transfer.amountMinor}
                    currency={report.event.currency}
                    size="md"
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="members-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="members-heading" className="text-lg font-bold text-ink">
          Members
        </h2>
        <ul className="flex flex-col gap-2">
          {report.members.map((member) => (
            <MemberRow key={member.memberId} report={report} member={member} />
          ))}
        </ul>
      </section>
    </div>
  );
}
