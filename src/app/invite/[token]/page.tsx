import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isSafeInviteToken } from "@/lib/auth-helpers";
import { getSession } from "@/lib/authorization";
import { acceptInvite, InviteError } from "@/services/invites";

export const instant = false;

const ERROR_VIEWS: Record<string, { title: string; body: string }> = {
  EMAIL_MISMATCH: {
    title: "Wrong account",
    body: "This invite was sent to a different email address. Sign in with that address, or ask the organizer to invite your account.",
  },
  INVITE_REVOKED: {
    title: "Invite revoked",
    body: "This invite was revoked. Ask the organizer to send it again.",
  },
  INVITE_EXPIRED: {
    title: "Invite expired",
    body: "This invite link has expired. Ask the organizer to resend it.",
  },
  INVITE_NOT_FOUND: {
    title: "Invite not found",
    body: "This invite link is invalid.",
  },
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!isSafeInviteToken(token)) {
    notFound();
  }

  const session = await getSession();
  if (!session) {
    redirect(`/register?invite=${encodeURIComponent(token)}`);
  }

  let eventId: string;
  try {
    ({ eventId } = await acceptInvite(token));
  } catch (error) {
    const view =
      error instanceof InviteError ? ERROR_VIEWS[error.code] : undefined;
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-6 flex items-center justify-center gap-3">
            <span
              aria-hidden="true"
              className="grid size-11 place-items-center rounded-card bg-accent text-xl font-extrabold text-white"
            >
              K
            </span>
            <span className="text-2xl font-extrabold tracking-tight text-ink">
              Kittie
            </span>
          </div>
          <div className="animate-rise rounded-card border border-border bg-surface p-6 shadow-soft">
            <h1 className="text-2xl font-extrabold tracking-tight text-ink">
              {view?.title ?? "Something went wrong"}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {view?.body ??
                "We could not accept this invite. Please try again."}
            </p>
            <Link
              href="/events"
              className="mt-5 inline-flex min-h-control items-center rounded-pill bg-accent px-5 text-base font-semibold text-white shadow-soft transition-colors hover:bg-accent-strong"
            >
              Go to your events
            </Link>
          </div>
        </div>
      </main>
    );
  }

  redirect(`/events/${eventId}`);
}
