"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const result = await authClient.requestPasswordReset({
      email,
      redirectTo: "/welcome/password",
    });
    if (result.error) {
      setError("Could not send the reset link, please try again");
      setLoading(false);
      return;
    }
    router.replace(`/check-email?email=${encodeURIComponent(email)}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">
          Reset your password
        </h1>
        <p className="mt-1 text-sm text-muted">
          Enter your email and we will send you a link to set a new password.
        </p>
      </div>
      <Input
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" fullWidth loading={loading}>
        Send reset link
      </Button>
      <p className="text-center text-sm text-muted">
        <Link href="/login" className="font-semibold text-accent-strong">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
