"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Dialog } from "@/components/ui";

const ERROR_MESSAGES: Record<string, string> = {
  MEMBER_HAS_EXPENSES:
    "This member has expenses in this event. Void them before removing the member.",
  CANNOT_REMOVE_SELF: "The organizer cannot be removed.",
  NOT_ORGANIZER: "Only the organizer can remove members.",
  EVENT_CLOSED: "This event is closed and read-only.",
  ALREADY_REMOVED: "This member has already been removed.",
  NOT_FOUND: "This member no longer exists.",
  UNAUTHENTICATED: "Your session expired. Please sign in again.",
};

export interface RemoveMemberButtonProps {
  path: string;
  name: string;
  actionLabel: string;
  confirmLabel: string;
  title: string;
  description: string;
}

export function RemoveMemberButton({
  path,
  name,
  actionLabel,
  confirmLabel,
  title,
  description,
}: RemoveMemberButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, { method: "DELETE" });
      if (!response.ok) {
        const data = (await response.json()) as {
          error?: string;
          message?: string;
        };
        setError(
          ERROR_MESSAGES[data.error ?? ""] ??
            data.message ??
            "Something went wrong. Please try again.",
        );
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="danger"
        aria-label={`${actionLabel} ${name}`}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {actionLabel}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title={title}
        description={description}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={remove}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        {error ? (
          <p role="alert" className="text-sm font-semibold text-danger">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
