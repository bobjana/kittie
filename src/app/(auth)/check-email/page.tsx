"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

export default function CheckEmailPage() {
  return (
    <Suspense fallback={null}>
      <CheckEmailContent />
    </Suspense>
  );
}

function CheckEmailContent() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold tracking-tight text-ink">
        Check your email
      </h1>
      <p className="text-sm leading-relaxed text-muted">
        We sent a link to{" "}
        <span className="font-semibold text-ink">{email}</span>. Open it to set
        your password. The link expires in 60 minutes.
      </p>
      <p className="text-sm text-muted">
        Did not get it? Check your spam folder, or{" "}
        <Link
          href="/forgot-password"
          className="font-semibold text-accent-strong"
        >
          ask for a new link
        </Link>
        .
      </p>
    </div>
  );
}
