// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  SplitEditor,
  type SplitEditorMember,
} from "../../../src/components/split-editor";
import { formatMinorUnits } from "../../../src/components/ui/amount";
import { PERCENT_ERRORS } from "../../../src/domain/percentage";

const THREE: SplitEditorMember[] = [
  { id: "m1", name: "Ann" },
  { id: "m2", name: "Bob" },
  { id: "m3", name: "Cara" },
];

const TWO: SplitEditorMember[] = [
  { id: "m1", name: "Ann" },
  { id: "m2", name: "Bob" },
];

function Harness({
  members,
  totalMinor = 1000,
}: {
  members: SplitEditorMember[];
  totalMinor?: number | null;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <SplitEditor
      members={members}
      totalMinor={totalMinor}
      currency="EUR"
      values={values}
      onChange={setValues}
    />
  );
}

afterEach(cleanup);

describe("SplitEditor", () => {
  it("labels every percentage input and asks for a decimal keyboard", () => {
    render(<Harness members={THREE} />);

    for (const name of ["Ann", "Bob", "Cara"]) {
      const field = screen.getByLabelText(name);
      expect(field.getAttribute("inputmode")).toBe("decimal");
      expect(field.getAttribute("enterkeyhint")).toBe("next");
      expect(field.className).toContain("tabular-nums");
      expect(field.parentElement?.className).toContain("min-h-control");
    }
  });

  it("announces a 33.3/33.3/33.4 split as 100% and previews 333/333/334 on 1000", async () => {
    const user = userEvent.setup();
    render(<Harness members={THREE} />);

    expect(screen.queryAllByText(/Share preview/)).toHaveLength(0);

    await user.type(screen.getByLabelText("Ann"), "33.3");
    await user.type(screen.getByLabelText("Bob"), "33.3");
    await user.type(screen.getByLabelText("Cara"), "33.4");

    expect(screen.getByRole("status").textContent).toBe("Total 100%");
    expect(
      screen.getAllByText(/Share preview/).map((node) => node.textContent),
    ).toEqual([
      `Share preview: ${formatMinorUnits(333, "EUR")}`,
      `Share preview: ${formatMinorUnits(333, "EUR")}`,
      `Share preview: ${formatMinorUnits(334, "EUR")}`,
    ]);
  });

  it("reports a 50/40 split as 100 basis points short of the total", async () => {
    const user = userEvent.setup();
    render(<Harness members={TWO} />);

    await user.type(screen.getByLabelText("Ann"), "50");
    await user.type(screen.getByLabelText("Bob"), "40");

    expect(screen.getByRole("status").textContent).toBe("Total 90% / 10% left");
  });

  it("rejects a negative value with a described-by error", async () => {
    const user = userEvent.setup();
    render(<Harness members={TWO} />);

    const ann = screen.getByLabelText("Ann");
    await user.type(ann, "-5");

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(PERCENT_ERRORS.NEGATIVE);
    expect(ann.getAttribute("aria-describedby")).toBe(alert.id);
    expect(ann.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe(
      "Enter a percentage for each person",
    );
  });

  it("rejects a value above 100 and clears the error once it is fixed", async () => {
    const user = userEvent.setup();
    render(<Harness members={TWO} />);

    const ann = screen.getByLabelText("Ann");
    await user.type(ann, "150");
    expect(screen.getByRole("alert").textContent).toBe(
      PERCENT_ERRORS.ABOVE_100,
    );

    await user.clear(ann);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(ann.getAttribute("aria-describedby")).toBeNull();

    await user.type(ann, "100");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.type(screen.getByLabelText("Bob"), "0");
    expect(screen.getByRole("status").textContent).toBe("Total 100%");
  });

  it("moves through the inputs in display order with Tab alone", async () => {
    const user = userEvent.setup();
    render(<Harness members={THREE} />);

    const ann = screen.getByLabelText("Ann");
    ann.focus();
    expect(document.activeElement).toBe(ann);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Bob"));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Cara"));
  });

  it("withholds the share preview until every field parses", async () => {
    const user = userEvent.setup();
    render(<Harness members={TWO} />);

    await user.type(screen.getByLabelText("Ann"), "50");
    expect(screen.queryAllByText(/Share preview/)).toHaveLength(0);

    await user.type(screen.getByLabelText("Bob"), "50");
    expect(
      screen.getAllByText(/Share preview/).map((node) => node.textContent),
    ).toEqual([
      `Share preview: ${formatMinorUnits(500, "EUR")}`,
      `Share preview: ${formatMinorUnits(500, "EUR")}`,
    ]);
  });
});
