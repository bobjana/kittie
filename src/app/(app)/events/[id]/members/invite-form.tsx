"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Input } from "@/components/ui";

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_EMAIL: "Enter a valid email address",
  ALREADY_MEMBER: "This email is already a member",
  INVITE_LIMIT_EXCEEDED: "You've reached today's invite limit",
};

export function InviteForm({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const response = await fetch(`/api/events/${eventId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        setError(
          ERROR_MESSAGES[data.error ?? ""] ??
            data.message ??
            "Could not send the invite.",
        );
        return;
      }
      setEmail("");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Input
          label="Email address"
          type="email"
          autoComplete="email"
          placeholder="friend@example.com"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {error ? (
          <p role="alert" className="text-sm font-semibold text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" loading={loading}>
          Send invite
        </Button>
      </form>
    </Card>
  );
}
