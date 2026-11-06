"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";

export interface NotificationJob {
  id: string;
  recipientEmail: string;
  displayName: string | null;
  status: "queued" | "running" | "sent" | "failed" | "cancelled";
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: string | null;
}

const STATUS_TONES: Record<
  NotificationJob["status"],
  "neutral" | "success" | "danger"
> = {
  queued: "neutral",
  running: "neutral",
  sent: "success",
  failed: "danger",
  cancelled: "neutral",
};

const STATUS_LABELS: Record<NotificationJob["status"], string> = {
  queued: "Queued",
  running: "Sending",
  sent: "Sent",
  failed: "Failed",
  cancelled: "Cancelled",
};

function recipientLabel(job: NotificationJob): string {
  return job.displayName?.trim() || job.recipientEmail;
}

/**
 * Organizer-only panel on the frozen report: shows the delivery status of
 * the final-tally email for each member and lets the organizer resend a
 * failed one. Delivery never blocks the close itself.
 */
export function DeliveryStatus({
  eventId,
  settlementId,
}: {
  eventId: string;
  settlementId: string;
}) {
  const [jobs, setJobs] = useState<NotificationJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resendingJobId, setResendingJobId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/events/${eventId}/settlements/${settlementId}/notifications`,
      );
      if (!response.ok) {
        setError("Could not load the tally email status.");
        return;
      }
      const data = (await response.json()) as {
        notifications: NotificationJob[];
      };
      setJobs(data.notifications);
      setError(null);
    } catch {
      setError("Could not load the tally email status.");
    }
  }, [eventId, settlementId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleResend(jobId: string) {
    setResendingJobId(jobId);
    setError(null);
    try {
      const response = await fetch(
        `/api/events/${eventId}/settlements/${settlementId}/notifications/resend`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        },
      );
      if (!response.ok) {
        setError("Could not resend this tally email.");
        return;
      }
      await load();
    } catch {
      setError("Could not resend this tally email.");
    } finally {
      setResendingJobId(null);
    }
  }

  return (
    <Card data-testid="delivery-status">
      <div className="flex items-center justify-between gap-2 px-4 pt-4">
        <h2 className="text-base font-semibold text-ink">Tally emails</h2>
        <Button
          type="button"
          variant="secondary"
          size="md"
          onClick={() => void load()}
          data-testid="delivery-status-refresh"
        >
          Refresh
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          data-testid="delivery-status-error"
          className="px-4 pt-2 text-sm text-danger"
        >
          {error}
        </p>
      ) : null}
      {jobs === null ? (
        <p className="px-4 py-3 text-sm text-muted">Loading status...</p>
      ) : jobs.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">
          No tally emails were queued for this settlement.
        </p>
      ) : (
        <ul className="flex flex-col gap-2 px-4 py-4">
          {jobs.map((job) => {
            const failed = job.status === "failed";
            return (
              <li
                key={job.id}
                className={cx(
                  "flex items-center gap-3 rounded-input border border-border bg-surface px-4 py-3",
                  failed && "border-danger/40",
                )}
                data-testid={`delivery-status-${recipientLabel(job)}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">
                    {recipientLabel(job)}
                  </p>
                  {job.errorMessage ? (
                    <p className="truncate text-xs text-muted">
                      {job.errorMessage}
                    </p>
                  ) : null}
                </div>
                <Badge tone={STATUS_TONES[job.status]}>
                  {STATUS_LABELS[job.status]}
                </Badge>
                {failed ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    disabled={resendingJobId !== null}
                    onClick={() => void handleResend(job.id)}
                    data-testid={`resend-tally-${recipientLabel(job)}`}
                  >
                    {resendingJobId === job.id ? "Resending..." : "Resend"}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
