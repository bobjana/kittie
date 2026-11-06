// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportView } from "../../../src/components/report/report-view";
import { TallyLanding } from "../../../src/components/report/tally-landing";
import { formatMinorUnits } from "../../../src/components/ui/amount";
import { Fab, FabLink } from "../../../src/components/ui/fab";
import type { EventReport } from "../../../src/services/reports";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : String(href)} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

const eur = (minor: number) => formatMinorUnits(minor, "EUR");

function makeReport(overrides: Partial<EventReport> = {}): EventReport {
  return {
    event: {
      id: "event-1",
      name: "Lisbon",
      currency: "EUR",
      status: "open",
      closedAt: null,
    },
    viewerMemberId: "member-a",
    totalSpentMinor: 40000,
    totalOwedMinor: 11666,
    members: [
      {
        memberId: "member-a",
        displayName: "Ana",
        emailNormalized: "ana@example.com",
        role: "organizer",
        paidMinor: 30000,
        shareMinor: 18334,
        netMinor: 11666,
      },
      {
        memberId: "member-b",
        displayName: "Bruno",
        emailNormalized: "bruno@example.com",
        role: "member",
        paidMinor: 10000,
        shareMinor: 11333,
        netMinor: -1333,
      },
    ],
    transfers: [
      { fromMemberId: "member-b", toMemberId: "member-a", amountMinor: 1333 },
    ],
    frozen: false,
    settlementId: null,
    ...overrides,
  };
}

describe("Fab", () => {
  it("is a 64px aria-labelled add-expense control", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toContain("--spacing-fab: 64px;");

    render(
      <Fab aria-label="Add expense">
        <span aria-hidden="true">+</span>
      </Fab>,
    );
    const button = screen.getByRole("button", { name: "Add expense" });
    expect(button.className).toContain("size-fab");
    expect(button.className).toContain("fixed");
    expect(button.className).toContain("safe-area-inset-bottom");
  });

  it("opens the new-expense page as a link", () => {
    render(
      <FabLink href="/events/event-1/expenses/new" aria-label="Add expense">
        +
      </FabLink>,
    );
    const link = screen.getByRole("link", { name: "Add expense" });
    expect(link.getAttribute("href")).toBe("/events/event-1/expenses/new");
    expect(link.className).toContain("size-fab");
  });
});

describe("ReportView", () => {
  it("renders the server-composed amounts without recomputing them", () => {
    render(<ReportView report={makeReport()} />);

    expect(screen.getByText(eur(40000))).toBeTruthy();
    const members = screen.getByRole("region", { name: "Members" });
    const viewerRow = within(members).getByText("Ana").closest("li");
    expect(viewerRow).not.toBeNull();
    const row = within(viewerRow as HTMLElement);
    expect(row.getByText("(you)")).toBeTruthy();
    expect(row.getByText(eur(18334))).toBeTruthy();
    expect(row.getByText(eur(11666))).toBeTruthy();
    expect(screen.getByText("you are owed")).toBeTruthy();

    const settleUp = screen.getByRole("region", { name: "Who pays whom" });
    const transferRow = within(settleUp).getByText("pays").closest("li");
    expect(transferRow).not.toBeNull();
    expect(
      within(transferRow as HTMLElement).getByText(eur(1333)),
    ).toBeTruthy();
  });

  it("takes the net sign from the server, not from paid minus share", () => {
    const report = makeReport({
      members: [
        {
          memberId: "member-a",
          displayName: "Ana",
          emailNormalized: "ana@example.com",
          role: "organizer",
          paidMinor: 1000,
          shareMinor: 400,
          netMinor: -999,
        },
      ],
      viewerMemberId: "member-a",
    });
    render(<ReportView report={report} />);
    expect(screen.getByText("you owe")).toBeTruthy();
    expect(screen.getAllByText(eur(999)).length).toBeGreaterThan(0);
  });

  it("announces a settled group when there are no transfers", () => {
    render(
      <ReportView
        report={makeReport({
          transfers: [],
          members: [
            {
              memberId: "member-a",
              displayName: "Ana",
              emailNormalized: "ana@example.com",
              role: "organizer",
              paidMinor: 500,
              shareMinor: 500,
              netMinor: 0,
            },
          ],
        })}
      />,
    );
    expect(
      screen.getByText("All settled up - nobody owes anybody."),
    ).toBeTruthy();
    expect(screen.getByText("Settled up")).toBeTruthy();
  });

  it("marks a closed report as frozen on the close date", () => {
    render(
      <ReportView
        report={makeReport({
          frozen: true,
          event: {
            id: "event-1",
            name: "Lisbon",
            currency: "EUR",
            status: "closed",
            closedAt: "2026-02-10T12:00:00.000Z",
          },
        })}
      />,
    );
    expect(
      screen.getByText(/Final tally - frozen on Feb 10, 2026/),
    ).toBeTruthy();
  });
});

describe("TallyLanding", () => {
  const twoOpen = [
    {
      id: "newer",
      name: "Newer trip",
      currency: "EUR",
      status: "open" as const,
      role: "organizer" as const,
      updatedAt: "2026-02-01T10:00:00.000Z",
      totalSpentMinor: 40000,
    },
    {
      id: "older",
      name: "Older trip",
      currency: "EUR",
      status: "open" as const,
      role: "member" as const,
      updatedAt: "2026-01-01T10:00:00.000Z",
      totalSpentMinor: 0,
    },
  ];

  it("gives every event card its own report and add-expense actions", () => {
    render(<TallyLanding openEvents={twoOpen} />);
    const addLinks = screen.getAllByRole("link", { name: "Add expense" });
    expect(addLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/events/newer/expenses/new",
      "/events/older/expenses/new",
    ]);
    const reportLinks = screen.getAllByRole("link", { name: "View report" });
    expect(reportLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/events/newer/report",
      "/events/older/report",
    ]);
  });

  it("opens the event chooser sheet from the FAB when several events are open", async () => {
    const user = userEvent.setup();
    render(<TallyLanding openEvents={twoOpen} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add expense" }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText("Add an expense to which event?"),
    ).toBeTruthy();
    const chooserLinks = within(dialog).getAllByRole("link");
    expect(chooserLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/events/newer/expenses/new",
      "/events/older/expenses/new",
    ]);
  });
});
