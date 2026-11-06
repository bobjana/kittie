// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryList } from "../../../src/components/history/history-list";
import type { HistoryEntry } from "../../../src/services/audit";

afterEach(cleanup);

const entries: HistoryEntry[] = [
  {
    id: "entry-1",
    action: "expense.personal_update",
    title: "Changed a personal amount",
    actorName: "Bruno",
    createdAt: "2026-11-01T10:00:00.000Z",
    changes: [
      {
        label: "Personal · Bruno",
        before: "€0.00",
        after: "€20.00",
      },
    ],
  },
  {
    id: "entry-2",
    action: "expense.void",
    title: "Voided an expense",
    actorName: "Ana",
    createdAt: "2026-11-01T11:00:00.000Z",
    changes: [
      { label: "Status", before: "Open", after: "Voided" },
      { label: "Amount", before: null, after: "€400.00" },
    ],
  },
];

describe("HistoryList", () => {
  it("renders a readable chronological timeline with actors and amounts", () => {
    const { container } = render(<HistoryList entries={entries} />);
    const items = container.querySelectorAll("ol > li");

    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Bruno");
    expect(items[0].textContent).toContain("Changed a personal amount");
    expect(items[0].textContent).toContain("€0.00");
    expect(items[0].textContent).toContain("€20.00");
    expect(items[1].textContent).toContain("Ana");
    expect(items[1].textContent).toContain("Voided an expense");
    expect(items[1].textContent).toContain("Open");
    expect(items[1].textContent).toContain("Voided");
    expect(items[1].textContent).toContain("€400.00");

    expect(container.textContent).not.toContain("{");
    expect(container.textContent).not.toMatch(
      /totalMinor|beforeJson|afterJson|personalMinor/,
    );
  });

  it("renders no rows for an empty history", () => {
    render(<HistoryList entries={[]} />);
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});
