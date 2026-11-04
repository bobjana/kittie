import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import { auth } from "@/lib/auth";
import { ProfileForm } from "./profile-form";

export const metadata = { title: "Profile" };

export default function ProfilePage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">
          Profile
        </h1>
        <p className="text-base text-muted">
          Your account details and password
        </p>
      </header>
      <Suspense fallback={<ProfileSkeleton />}>
        <ProfileContent />
      </Suspense>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Skeleton className="h-64" />
      <Skeleton className="h-80" />
    </div>
  );
}

async function ProfileContent() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/login");
  }

  return (
    <ProfileForm initialName={session.user.name} email={session.user.email} />
  );
}
