"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { isSafeNextPath, POST_AUTH_REDIRECT } from "@/lib/auth-helpers";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? undefined;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const result = await authClient.signIn.email({
      email,
      password,
      rememberMe: true,
    });
    if (result.error) {
      setError("Email or password is incorrect");
      setLoading(false);
      return;
    }
    router.replace(next && isSafeNextPath(next) ? next : POST_AUTH_REDIRECT);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">
          Welcome back
        </h1>
        <p className="mt-1 text-sm text-muted">
          Sign in to your Kittie account.
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
      <Input
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" fullWidth loading={loading}>
        Sign in
      </Button>
      <p className="text-center text-sm text-muted">
        New here?{" "}
        <Link href="/register" className="font-semibold text-accent-strong">
          Create an account
        </Link>
      </p>
      <p className="text-center text-sm">
        <Link
          href="/forgot-password"
          className="font-semibold text-accent-strong"
        >
          Forgot your password?
        </Link>
      </p>
    </form>
  );
}
