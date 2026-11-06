"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Card, Dialog } from "@/components/ui";
import { Amount } from "@/components/ui/amount";
import { cx } from "@/components/ui/cx";
import { Fab } from "@/components/ui/fab";
import type { TallyEventCard } from "@/services/reports";

const secondaryLinkClass = cx(
  "inline-flex min-h-control items-center rounded-pill border border-border bg-surface px-4 text-base font-semibold text-ink",
  "transition-colors hover:bg-lavender",
);

const primaryLinkClass = cx(
  "inline-flex min-h-control items-center rounded-pill bg-accent px-4 text-base font-semibold text-white shadow-soft",
  "transition-colors hover:bg-accent-strong",
);

export function TallyLanding({ openEvents }: { openEvents: TallyEventCard[] }) {
  const [chooserOpen, setChooserOpen] = useState(false);
  return (
    <>
      <ul className="flex flex-col gap-3">
        {openEvents.map((event) => (
          <li key={event.id}>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-lg font-bold text-ink">
                    {event.name}
                  </p>
                  <Amount
                    minorUnits={event.totalSpentMinor}
                    currency={event.currency}
                    size="md"
                  />
                </div>
                <Badge tone="success">Open</Badge>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  href={`/events/${event.id}/report`}
                  className={secondaryLinkClass}
                >
                  View report
                </Link>
                <Link
                  href={`/events/${event.id}/expenses/new`}
                  className={primaryLinkClass}
                >
                  Add expense
                </Link>
              </div>
            </Card>
          </li>
        ))}
      </ul>

      <Fab aria-label="Add expense" onClick={() => setChooserOpen(true)}>
        +
      </Fab>
      <Dialog
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        title="Add an expense to which event?"
        description="Pick one of your open events."
      >
        <ul className="flex flex-col gap-2">
          {openEvents.map((event) => (
            <li key={event.id}>
              <Link
                href={`/events/${event.id}/expenses/new`}
                onClick={() => setChooserOpen(false)}
                className={cx(
                  "flex min-h-control items-center justify-between gap-3 rounded-input border border-border bg-surface px-4 py-3 text-base font-semibold text-ink",
                  "transition-colors hover:bg-lavender",
                )}
              >
                {event.name}
                <span className="text-muted">{event.currency}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
