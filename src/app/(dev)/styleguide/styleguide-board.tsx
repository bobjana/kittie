"use client";

import { type ReactNode, useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  Amount,
  Avatar,
  Badge,
  Button,
  Card,
  CardText,
  CardTitle,
  Checkbox,
  CurrencyInput,
  Dialog,
  EmptyState,
  Fab,
  IconButton,
  Input,
  PercentageInput,
  Skeleton,
  Toast,
} from "@/components/ui";

const COLOR_TOKENS = [
  { name: "--color-canvas", value: "#F7F3FF", swatch: "bg-canvas" },
  { name: "--color-surface", value: "#FFFFFF", swatch: "bg-surface" },
  { name: "--color-ink", value: "#241F35", swatch: "bg-ink" },
  { name: "--color-muted", value: "#6D6585", swatch: "bg-muted" },
  { name: "--color-lavender", value: "#EDE7FF", swatch: "bg-lavender" },
  { name: "--color-mint", value: "#D9F7E9", swatch: "bg-mint" },
  { name: "--color-accent", value: "#6D28D9", swatch: "bg-accent" },
  {
    name: "--color-accent-strong",
    value: "#4C1D95",
    swatch: "bg-accent-strong",
  },
  { name: "--color-success", value: "#047857", swatch: "bg-success" },
  { name: "--color-danger", value: "#B91C1C", swatch: "bg-danger" },
  { name: "--color-border", value: "#E7E0F5", swatch: "bg-border" },
];

const RADIUS_TOKENS = [
  { name: "--radius-input", value: "16px", className: "rounded-input" },
  { name: "--radius-card", value: "24px", className: "rounded-card" },
  { name: "--radius-pill", value: "999px", className: "rounded-pill" },
];

const TYPE_TOKENS = [
  {
    name: "Display",
    sample: "Dinner in Lisbon",
    className: "text-4xl font-extrabold tracking-tight",
  },
  { name: "Heading", sample: "Who owes whom", className: "text-2xl font-bold" },
  {
    name: "Body",
    sample: "Split expenses with friends, exactly to the cent.",
    className: "text-base",
  },
  {
    name: "Caption",
    sample: "Updated 3 minutes ago",
    className: "text-sm font-medium text-muted",
  },
];

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-2xl font-bold text-ink">
          {title}
        </h2>
        <p className="max-w-2xl text-base text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

function SwatchRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

function TokensSection() {
  return (
    <Section
      id="tokens"
      title="Tokens"
      description="Every colour, radius, elevation and type step in the Kittie system is declared in src/app/globals.css."
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {COLOR_TOKENS.map((token) => (
          <div
            key={token.name}
            className="rounded-card border border-border bg-surface p-3"
          >
            <div
              aria-hidden="true"
              className={`h-14 w-full rounded-input border border-border ${token.swatch}`}
            />
            <p className="mt-3 text-sm font-bold text-ink">{token.name}</p>
            <p className="text-sm text-muted">{token.value}</p>
          </div>
        ))}
      </div>

      <SwatchRow>
        {RADIUS_TOKENS.map((token) => (
          <div
            key={token.name}
            className={`grid size-24 place-items-center border border-border bg-surface text-center ${token.className}`}
          >
            <span>
              <span className="block text-sm font-bold text-ink">
                {token.name}
              </span>
              <span className="block text-sm text-muted">{token.value}</span>
            </span>
          </div>
        ))}
        <div className="grid size-24 place-items-center rounded-card bg-surface text-center shadow-soft">
          <span>
            <span className="block text-sm font-bold text-ink">
              --shadow-soft
            </span>
            <span className="block text-sm text-muted">0 12px 30px</span>
          </span>
        </div>
      </SwatchRow>

      <div className="flex flex-col gap-2 rounded-card border border-border bg-surface p-5">
        {TYPE_TOKENS.map((step) => (
          <div
            key={step.name}
            className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2 last:border-b-0 last:pb-0"
          >
            <span className={step.className}>{step.sample}</span>
            <span className="text-sm font-semibold text-muted">
              {step.name}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ButtonsSection({ onOpenDialog }: { onOpenDialog: () => void }) {
  return (
    <Section
      id="buttons"
      title="Buttons"
      description="Pill controls with a 44px minimum target; the large primary action is 52px and the floating action button is 64px."
    >
      <Card className="flex flex-col gap-5">
        <SwatchRow>
          <Button data-testid="button-primary">Add expense</Button>
          <Button variant="secondary">Invite a friend</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">Delete event</Button>
        </SwatchRow>
        <SwatchRow>
          <Button size="lg" data-testid="button-primary-lg">
            Settle up
          </Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
        </SwatchRow>
        <SwatchRow>
          <IconButton aria-label="Add a receipt">
            <span aria-hidden="true" className="text-xl leading-none">
              +
            </span>
          </IconButton>
          <IconButton aria-label="Edit expense" variant="secondary">
            <span aria-hidden="true" className="text-xl leading-none">
              ✎
            </span>
          </IconButton>
          <IconButton aria-label="Scan receipt" variant="primary">
            <span aria-hidden="true" className="text-xl leading-none">
              ◎
            </span>
          </IconButton>
          <Button
            variant="secondary"
            onClick={onOpenDialog}
            data-testid="dialog-trigger"
          >
            Open sample dialog
          </Button>
        </SwatchRow>
      </Card>
    </Section>
  );
}

function InputsSection() {
  return (
    <Section
      id="inputs"
      title="Inputs"
      description="Currency and percentage fields keep a large tabular display with the right mobile keyboards."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-5">
          <Input
            label="Event name"
            placeholder="Lisbon weekend"
            hint="Shown to everyone in the event."
          />
          <Input
            label="Your email"
            placeholder="you@example.com"
            defaultValue="not-an-email"
            error="Enter a valid email address."
          />
          <Checkbox
            label="Email me when someone adds an expense"
            hint="You can change this later in your profile."
          />
          <Checkbox
            label="I agree to the rules"
            error="You must accept the rules to continue."
          />
        </Card>

        <Card className="flex flex-col gap-5">
          <CurrencyInput label="Total" defaultValue="42.50" />
          <PercentageInput label="Service charge" defaultValue="12.5" />
          <Input label="Note" placeholder="Dinner at the pier" suffix="EUR" />
          <Input
            label="Locked field"
            defaultValue="Read only"
            disabled
            hint="Disabled controls stay out of the tab order."
          />
        </Card>
      </div>
    </Section>
  );
}

function DataSection() {
  return (
    <Section
      id="data"
      title="Cards, badges and amounts"
      description="Amounts always render with tabular figures so columns of money line up."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-4">
          <CardTitle>Lisbon weekend</CardTitle>
          <CardText>4 people · 12 expenses · 3 days left</CardText>
          <div className="flex flex-wrap gap-2">
            <Badge>Open</Badge>
            <Badge tone="accent">You are owed</Badge>
            <Badge tone="success">Settled</Badge>
            <Badge tone="danger">Overdue</Badge>
          </div>
          <ul className="flex flex-col gap-2">
            <li className="flex items-center justify-between gap-3 border-b border-border pb-2">
              <span className="text-base text-ink">Mara owes you</span>
              <Amount minorUnits={123456} locale="en-IE" tone="success" />
            </li>
            <li className="flex items-center justify-between gap-3 border-b border-border pb-2">
              <span className="text-base text-ink">You owe Jonas</span>
              <Amount minorUnits={-4599} locale="en-IE" tone="danger" />
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-base text-ink">Total spent</span>
              <Amount minorUnits={98700} locale="en-IE" size="lg" />
            </li>
          </ul>
        </Card>

        <Card className="flex flex-col gap-4">
          <CardTitle>People</CardTitle>
          <SwatchRow>
            <Avatar name="Mara Silva" />
            <Avatar name="Jonas Weber" size="lg" />
            <Avatar name="Priya Raghavan" />
            <Avatar name="Tomás Almeida" size="sm" />
          </SwatchRow>
          <CardText>
            Initials and tints are derived from the name, so the same person
            keeps the same avatar everywhere.
          </CardText>
        </Card>
      </div>
    </Section>
  );
}

function FeedbackSection() {
  return (
    <Section
      id="feedback"
      title="Feedback"
      description="Toasts announce politely, errors announce assertively, and skeletons collapse under prefers-reduced-motion."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-4">
          <CardTitle>Toasts</CardTitle>
          <Toast tone="success" title="Expense saved">
            Dinner at the pier was split between 4 people.
          </Toast>
          <Toast tone="error" title="Could not reach the server">
            Check your connection and try again.
          </Toast>
          <CardText>
            Success and info toasts announce politely; errors use an assertive
            alert role. Wrap a set in ToastViewport to float them bottom-right.
          </CardText>
        </Card>

        <div className="flex flex-col gap-4">
          <EmptyState
            title="No expenses yet"
            description="Add the first receipt and Kittie will work out who owes whom."
            icon="🧾"
            action={<Button>Add expense</Button>}
          />
          <Card className="flex flex-col gap-3">
            <CardTitle>Loading</CardTitle>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </Card>
        </div>
      </div>
    </Section>
  );
}

export function StyleguideBoard() {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <AppShell title="Styleguide">
      <div
        className="mx-auto flex w-full max-w-5xl flex-col gap-12"
        data-testid="styleguide"
      >
        <header className="flex flex-col gap-3">
          <div>
            <Badge tone="accent">Dev only</Badge>
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-ink">
            Kittie styleguide
          </h1>
          <p className="max-w-2xl text-lg text-muted">
            Every token, control and layout primitive in the Kittie design
            system. This page is served in development only.
          </p>
        </header>

        <TokensSection />
        <ButtonsSection onOpenDialog={() => setDialogOpen(true)} />
        <InputsSection />
        <DataSection />
        <FeedbackSection />
      </div>

      <Fab aria-label="Add expense" data-testid="fab">
        <span aria-hidden="true">+</span>
      </Fab>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Delete this expense?"
        description="Everyone in the event will see the expense disappear. This cannot be undone."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setDialogOpen(false)}
              data-testid="dialog-cancel"
            >
              Keep expense
            </Button>
            <Button
              variant="danger"
              onClick={() => setDialogOpen(false)}
              data-testid="dialog-confirm"
            >
              Delete expense
            </Button>
          </>
        }
      >
        <Input
          label="Reason"
          placeholder="Duplicate of dinner on Friday"
          data-testid="dialog-reason"
        />
      </Dialog>
    </AppShell>
  );
}
