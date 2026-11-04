"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar, Badge, Button } from "@/components/ui";
import { RemoveMemberButton } from "./remove-member";

export interface PendingInviteItem {
  memberId: string;
  emailNormalized: string;
  displayName: string | null;
  invitedAt: string | null;
  expiresAt: string | null;
  status: "pending" | "expired";
}

export function PendingInvites({
  eventId,
  invites,
  isOrganizer,
}: {
  eventId: string;
  invites: PendingInviteItem[];
  isOrganizer: boolean;
}) {
  if (invites.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-2">
      {invites.map((invite) => (
        <PendingInviteRow
          key={invite.memberId}
          eventId={eventId}
          invite={invite}
          isOrganizer={isOrganizer}
        />
      ))}
    </ul>
  );
}

function PendingInviteRow({
  eventId,
  invite,
  isOrganizer,
}: {
  eventId: string;
  invite: PendingInviteItem;
  isOrganizer: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/events/${eventId}/invites/${invite.memberId}/resend`,
        { method: "POST" },
      );
      if (!response.ok) {
        const data = (await response.json()) as { message?: string };
        setError(data.message ?? "Something went wrong. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const name = invite.displayName ?? invite.emailNormalized;

  return (
    <li className="flex flex-col gap-2 rounded-input border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-3">
        <Avatar name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-ink">{name}</p>
          <p className="truncate text-sm text-muted">
            {invite.emailNormalized}
          </p>
        </div>
        <Badge tone={invite.status === "pending" ? "accent" : "neutral"}>
          {invite.status === "pending" ? "Pending" : "Expired"}
        </Badge>
        {isOrganizer ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              loading={busy}
              disabled={busy}
              onClick={resend}
            >
              Resend
            </Button>
            <RemoveMemberButton
              path={`/api/events/${eventId}/members/${invite.memberId}`}
              name={name}
              actionLabel="Revoke"
              confirmLabel="Revoke invite"
              title="Revoke invite?"
              description={`The invite for ${name} will be cancelled and can no longer be used to join.`}
            />
          </div>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
