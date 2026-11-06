"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Checkbox, Dialog } from "@/components/ui";

export interface SettlementActionsProps {
  eventId: string;
  status: "open" | "closed";
  isOrganizer: boolean;
}

const ERROR_MESSAGES: Record<string, string> = {
  NOT_ORGANIZER: "Only the organizer can close or reopen the event.",
  EVENT_CLOSED: "The event is already closed.",
  EVENT_NOT_CLOSED: "The event is not closed.",
  CONFIRMATION_REQUIRED: "Confirm that you want to reopen the event.",
  NOT_FOUND: "This event no longer exists.",
};

function errorMessage(code: string | undefined): string {
  return (code && ERROR_MESSAGES[code]) ?? "Something went wrong. Try again.";
}

/**
 * Row 19: the organizer's close and reopen controls. Close freezes the
 * tally into a settlement snapshot and queues the tally emails; reopen
 * supersedes that snapshot after an explicit confirmation. Members never
 * see these controls, and the API refuses them with 403 regardless.
 */
export function SettlementActions({
  eventId,
  status,
  isOrganizer,
}: SettlementActionsProps) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"close" | "reopen" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isOrganizer) {
    return null;
  }

  const isClose = status === "open";
  const canSubmit = !submitting && (!isClose ? confirmed : true);

  function openDialog() {
    setError(null);
    setConfirmed(false);
    setDialog(isClose ? "close" : "reopen");
  }

  function closeDialog() {
    if (submitting) return;
    setDialog(null);
    setConfirmed(false);
    setError(null);
  }

  async function handleConfirm() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = isClose
        ? await fetch(`/api/events/${eventId}/close`, { method: "POST" })
        : await fetch(`/api/events/${eventId}/reopen`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: true }),
          });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(errorMessage(data.error));
        return;
      }
      setDialog(null);
      setConfirmed(false);
      router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        type="button"
        variant={isClose ? "primary" : "secondary"}
        size="md"
        onClick={openDialog}
        data-testid={isClose ? "close-event-button" : "reopen-event-button"}
      >
        {isClose ? "Close event" : "Reopen event"}
      </Button>

      <Dialog
        open={dialog !== null}
        onClose={closeDialog}
        title={isClose ? "Close the event?" : "Reopen the event?"}
        description={
          isClose
            ? "The tally is frozen as the final report, the event becomes read-only, and everyone gets a tally email."
            : "The event becomes editable again and the frozen tally is superseded. No email is sent until the next close."
        }
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={closeDialog}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={isClose ? "primary" : "danger"}
              onClick={handleConfirm}
              loading={submitting}
              disabled={!canSubmit}
              data-testid={
                isClose ? "confirm-close-event" : "confirm-reopen-event"
              }
            >
              {isClose ? "Close event" : "Reopen event"}
            </Button>
          </>
        }
      >
        {isClose ? null : (
          <Checkbox
            id="reopen-confirm"
            label="I understand this unfreezes the tally"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
        )}
        {error ? (
          <p
            role="alert"
            data-testid="settlement-error"
            className="mt-3 text-sm font-semibold text-danger"
          >
            {error}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
