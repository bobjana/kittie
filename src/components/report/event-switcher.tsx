"use client";

import { useRouter } from "next/navigation";
import { useId } from "react";
import { cx } from "@/components/ui/cx";

export interface SwitcherEvent {
  id: string;
  name: string;
  status: "open" | "closed";
}

export function EventSwitcher({
  events,
  currentEventId,
}: {
  events: SwitcherEvent[];
  currentEventId: string;
}) {
  const router = useRouter();
  const labelId = useId();
  if (events.length <= 1) {
    return null;
  }
  return (
    <label
      htmlFor={labelId}
      className="inline-flex min-h-control items-center gap-2 text-base font-semibold text-ink"
    >
      <span className="sr-only">Switch event</span>
      <select
        id={labelId}
        value={currentEventId}
        onChange={(event) =>
          router.push(`/events/${event.target.value}/report`)
        }
        className={cx(
          "min-h-control rounded-input border border-border bg-surface px-3 py-2 text-base font-semibold text-ink",
          "transition-colors focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25",
        )}
      >
        {events.map((event) => (
          <option key={event.id} value={event.id}>
            {event.name}
            {event.status === "closed" ? " (closed)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
