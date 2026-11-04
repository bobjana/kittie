"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialEmail = searchParams.get("email") ?? "";
  const next = searchParams.get("next") ?? undefined;
  const invite = searchParams.get("invite") ?? undefined;
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, next, invite }),
    });
    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
    };
    if (!response.ok) {
      setError(
        data.error === "INVALID_EMAIL"
          ? "Enter a valid email address"
          : "Something went wrong, please try again",
      );
      setLoading(false);
      return;
    }
    const params = new URLSearchParams();
    params.set("email", email);
    if (next) {
      params.set("next", next);
    }
    if (invite) {
      params.set("invite", invite);
    }
    router.replace(`/check-email?${params.toString()}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">
          Create your account
        </h1>
        <p className="mt-1 text-sm text-muted">
          We will email you a link to set your password.
        </p>
      </div>
      <Input
        label="Email"
        type="email"
        autoComplete="email"
        required
        readOnly={initialEmail !== ""}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" fullWidth loading={loading}>
        Continue
      </Button>
      <p className="text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-accent-strong">
          Sign in
        </Link>
      </p>
    </form>
  );
}
