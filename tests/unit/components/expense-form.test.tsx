// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpenseForm } from "../../../src/components/expense-form";
import type { ParticipantOption } from "../../../src/components/participant-picker";
import { formatMinorUnits } from "../../../src/components/ui/amount";
import { PERCENT_ERRORS } from "../../../src/domain/percentage";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const THREE: ParticipantOption[] = [
  { id: "m1", displayName: "Ann", emailNormalized: "ann@example.com" },
  { id: "m2", displayName: "Bob", emailNormalized: "bob@example.com" },
  { id: "m3", displayName: "Cara", emailNormalized: "cara@example.com" },
];

const TWO: ParticipantOption[] = [
  { id: "m1", displayName: "Ann", emailNormalized: "ann@example.com" },
  { id: "m2", displayName: "Bob", emailNormalized: "bob@example.com" },
];

function renderForm(members: ParticipantOption[]) {
  const view = render(
    <ExpenseForm
      eventId="e1"
      currency="EUR"
      members={members}
      currentMemberId="m1"
    />,
  );
  const form = view.container.querySelector("form");
  if (!form) {
    throw new Error("expected the expense form to render a form element");
  }
  return { ...view, form };
}

function splitEditorWithin() {
  const section = screen
    .getByRole("heading", { name: "Percentages" })
    .closest("section");
  if (!section) {
    throw new Error("expected the split editor section to render");
  }
  return within(section);
}

async function enterAmountAndMode(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Amount"), "10.00");
  await user.click(screen.getByRole("button", { name: "Percentages" }));
}

async function enterPercentages(
  user: ReturnType<typeof userEvent.setup>,
  entries: Array<[string, string]>,
) {
  await enterAmountAndMode(user);
  for (const [name, value] of entries) {
    await user.type(splitEditorWithin().getByLabelText(name), value);
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ExpenseForm percentage gate", () => {
  it("enables Save only once the split is exactly 100%", async () => {
    const user = userEvent.setup();
    renderForm(THREE);

    await enterAmountAndMode(user);
    const save = screen.getByRole("button", { name: "Save expense" });
    expect(save).toHaveProperty("disabled", true);

    const editor = splitEditorWithin();
    await user.type(editor.getByLabelText("Ann"), "33.3");
    expect(save).toHaveProperty("disabled", true);
    await user.type(editor.getByLabelText("Bob"), "33.3");
    expect(save).toHaveProperty("disabled", true);
    await user.type(editor.getByLabelText("Cara"), "33.4");
    expect(save).toHaveProperty("disabled", false);
    expect(screen.getByRole("status").textContent).toBe("Total 100%");
  });

  it("keeps Save disabled and announces the 10% remainder for 50/40", async () => {
    const user = userEvent.setup();
    renderForm(TWO);

    await enterPercentages(user, [
      ["Ann", "50"],
      ["Bob", "40"],
    ]);

    expect(screen.getByRole("button", { name: "Save expense" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("status").textContent).toBe("Total 90% / 10% left");
  });

  it("shows the per-person shares the server will compute", async () => {
    const user = userEvent.setup();
    renderForm(THREE);

    await enterPercentages(user, [
      ["Ann", "33.3"],
      ["Bob", "33.3"],
      ["Cara", "33.4"],
    ]);

    const rows = splitEditorWithin()
      .getAllByRole("listitem")
      .map((row) => row.textContent);

    expect(rows[0]).toContain(`Share preview: ${formatMinorUnits(333, "EUR")}`);
    expect(rows[1]).toContain(`Share preview: ${formatMinorUnits(333, "EUR")}`);
    expect(rows[2]).toContain(`Share preview: ${formatMinorUnits(334, "EUR")}`);
  });

  it("surfaces negative and above-100 field errors through aria-describedby", async () => {
    const user = userEvent.setup();
    renderForm(TWO);

    await enterAmountAndMode(user);
    const ann = splitEditorWithin().getByLabelText("Ann");

    await user.type(ann, "-5");
    const negativeAlert = screen.getByRole("alert");
    expect(negativeAlert.textContent).toBe(PERCENT_ERRORS.NEGATIVE);
    expect(ann.getAttribute("aria-describedby")).toBe(negativeAlert.id);
    expect(ann.getAttribute("aria-invalid")).toBe("true");

    await user.clear(ann);
    expect(screen.queryByRole("alert")).toBeNull();

    await user.type(ann, "150");
    expect(screen.getByRole("alert").textContent).toBe(
      PERCENT_ERRORS.ABOVE_100,
    );
    expect(screen.getByRole("button", { name: "Save expense" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("refuses an under-100 split even when the disabled button is bypassed", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { form } = renderForm(TWO);

    await enterPercentages(user, [
      ["Ann", "50"],
      ["Bob", "40"],
    ]);

    await act(async () => {
      fireEvent.submit(form);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits the exact basis points once the split reaches 100%", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const { form } = renderForm(THREE);

    await enterPercentages(user, [
      ["Ann", "33.3"],
      ["Bob", "33.3"],
      ["Cara", "33.4"],
    ]);

    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/events/e1/expenses");
    const body = JSON.parse(String(init.body)) as {
      splitMode: string;
      participants: Array<{ memberId: string; splitBp?: number }>;
    };
    expect(body.splitMode).toBe("percentage");
    expect(
      body.participants.map((participant) => participant.memberId),
    ).toEqual(["m1", "m2", "m3"]);
    expect(body.participants.map((participant) => participant.splitBp)).toEqual(
      [3330, 3330, 3340],
    );
  });
});
