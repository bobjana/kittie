"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_TOKEN: "This link is invalid or has expired. Ask for a new one.",
  EMAIL_MISMATCH: "This link does not match the email address shown.",
  INVALID_PASSWORD: "Passwords must be at least 8 characters.",
};

export default function SetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <SetPasswordForm />
    </Suspense>
  );
}

function SetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const email = searchParams.get("email") ?? "";
  const next = searchParams.get("next") ?? undefined;
  const invite = searchParams.get("invite") ?? undefined;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const missingLink = !token || !email;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    const response = await fetch("/api/auth/set-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, email, password, next, invite }),
    });
    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      redirectTo?: string;
    };
    if (!response.ok) {
      setError(ERROR_MESSAGES[data.error ?? ""] ?? "Something went wrong");
      setLoading(false);
      return;
    }
    router.replace(data.redirectTo ?? "/tally");
    router.refresh();
  }

  if (missingLink) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">
          Link expired
        </h1>
        <p className="text-sm text-muted">
          This password link is missing or malformed. Ask for a new one to
          continue.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">
          Set your password
        </h1>
        <p className="mt-1 break-all text-sm text-muted">{email}</p>
      </div>
      <Input
        label="Password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Input
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" fullWidth loading={loading}>
        Set password and sign in
      </Button>
    </form>
  );
}
