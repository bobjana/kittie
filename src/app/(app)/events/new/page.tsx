"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, Card, Input } from "@/components/ui";

const CURRENCIES = [
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
  "JPY",
  "CAD",
  "AUD",
  "NZD",
  "ZAR",
  "BRL",
  "MXN",
] as const;

export default function NewEventPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<string>("EUR");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          currency,
          startsOn: startsOn || null,
          endsOn: endsOn || null,
        }),
      });
      const data = (await response.json()) as {
        event?: { id: string };
        error?: string;
        message?: string;
      };

      if (!response.ok) {
        if (response.status === 401) {
          router.push("/login");
          return;
        }
        setError(data.message ?? data.error ?? "Could not create the event.");
        return;
      }

      router.push(`/events/${data.event?.id}`);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <header className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">
          New event
        </h1>
        <p className="text-base text-muted">
          Start a trip or dinner to split with friends.
        </p>
      </header>

      <Card>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-5"
          noValidate
        >
          <Input
            label="Event name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Lisbon 2026"
            required
            autoFocus
          />
          <div className="flex flex-col">
            <label
              htmlFor="currency"
              className="mb-1.5 text-sm font-semibold text-ink"
            >
              Currency
            </label>
            <select
              id="currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="min-h-control rounded-input border border-border bg-surface px-4 text-base font-semibold text-ink transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Starts"
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
            />
            <Input
              label="Ends"
              type="date"
              value={endsOn}
              onChange={(e) => setEndsOn(e.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm font-semibold text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" fullWidth loading={submitting}>
            Create event
          </Button>
        </form>
      </Card>
    </div>
  );
}
