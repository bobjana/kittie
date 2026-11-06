import { Card } from "@/components/ui";
import type { HistoryEntry } from "@/services/audit";

interface HistoryListProps {
  entries: HistoryEntry[];
}

/** A readable, chronological audit timeline. Never renders the raw JSON. */
export function HistoryList({ entries }: HistoryListProps) {
  return (
    <ol aria-label="Event history" className="flex flex-col gap-3">
      {entries.map((entry) => (
        <li key={entry.id}>
          <Card className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-base font-semibold text-ink">
                {entry.actorName}
              </p>
              <time
                dateTime={entry.createdAt}
                className="text-sm tabular-nums text-muted"
              >
                {formatWhen(entry.createdAt)}
              </time>
            </div>
            <p className="text-base text-ink">{entry.title}</p>
            {entry.changes.length > 0 ? (
              <dl className="mt-2 flex flex-col gap-1 border-t border-border pt-2 text-sm">
                {entry.changes.map((change, index) => (
                  <div
                    key={`${entry.id}-${index}`}
                    className="flex flex-wrap items-baseline gap-x-2"
                  >
                    <dt className="font-medium text-muted">{change.label}</dt>
                    <dd className="text-ink">
                      <ChangeValue
                        before={change.before}
                        after={change.after}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </Card>
        </li>
      ))}
    </ol>
  );
}

function ChangeValue({
  before,
  after,
}: {
  before: string | null;
  after: string | null;
}) {
  if (before !== null && after !== null) {
    return (
      <>
        <span className="text-muted">{before}</span>
        <span aria-hidden="true"> → </span>
        <span className="font-semibold">{after}</span>
      </>
    );
  }
  return <span>{after ?? before}</span>;
}

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(iso));
}
