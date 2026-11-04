import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Avatar, Badge, EmptyState, Skeleton } from "@/components/ui";
import { AuthorizationError } from "@/lib/authorization";
import { getMembersPageData, type MembersPageData } from "@/services/invites";
import { InviteForm } from "./invite-form";
import { PendingInvites } from "./pending-list";
import { RemoveMemberButton } from "./remove-member";

export const metadata = { title: "Members" };

export default function MembersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <Suspense fallback={<MembersSkeleton />}>
        <MembersContent params={params} />
      </Suspense>
    </div>
  );
}

function MembersSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-32" />
      <Skeleton className="h-40" />
    </div>
  );
}

async function MembersContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data: MembersPageData;
  try {
    data = await getMembersPageData(id);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.status === 401) redirect("/login");
      if (error.status === 404) notFound();
    }
    throw error;
  }

  return (
    <>
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            {data.event.name}
          </h1>
          <p className="text-base text-muted">Members</p>
        </div>
        <Link
          href={`/events/${id}`}
          className="inline-flex min-h-control items-center rounded-pill border border-border bg-surface px-4 text-base font-semibold text-ink transition-colors hover:bg-lavender"
        >
          Back to event
        </Link>
      </header>

      {data.isOrganizer ? (
        <section className="mb-6">
          <h2 className="mb-3 text-lg font-bold text-ink">Invite a friend</h2>
          <InviteForm eventId={id} />
        </section>
      ) : null}

      <section className="mb-6">
        <h2 className="mb-3 text-lg font-bold text-ink">Members</h2>
        {data.activeMembers.length === 0 ? (
          <EmptyState
            title="No members yet"
            description="Invited friends appear here once they join."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {data.activeMembers.map((member) => {
              const name = member.displayName ?? member.emailNormalized;
              return (
                <li
                  key={member.id}
                  className="flex items-center gap-3 rounded-input border border-border bg-surface px-4 py-3"
                >
                  <Avatar name={name} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-semibold text-ink">
                      {name}
                    </p>
                    {member.displayName ? (
                      <p className="truncate text-sm text-muted">
                        {member.emailNormalized}
                      </p>
                    ) : null}
                  </div>
                  {member.role === "organizer" ? (
                    <Badge tone="accent">Organizer</Badge>
                  ) : null}
                  {data.isOrganizer && member.role !== "organizer" ? (
                    <RemoveMemberButton
                      path={`/api/events/${id}/members/${member.id}`}
                      name={name}
                      actionLabel="Remove"
                      confirmLabel="Remove member"
                      title="Remove member?"
                      description={`${name} will lose access to this event.`}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {data.pendingInvites.length > 0 ? (
        <section>
          <h2 className="mb-3 text-lg font-bold text-ink">Pending invites</h2>
          <PendingInvites
            eventId={id}
            isOrganizer={data.isOrganizer}
            invites={data.pendingInvites.map((invite) => ({
              memberId: invite.memberId,
              emailNormalized: invite.emailNormalized,
              displayName: invite.displayName,
              invitedAt: invite.invitedAt?.toISOString() ?? null,
              expiresAt: invite.expiresAt?.toISOString() ?? null,
              status: invite.status,
            }))}
          />
        </section>
      ) : null}
    </>
  );
}
