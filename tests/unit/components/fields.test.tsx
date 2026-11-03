// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Checkbox } from "../../../src/components/ui/checkbox";
import { CurrencyInput } from "../../../src/components/ui/currency-input";
import { PercentageInput } from "../../../src/components/ui/percentage-input";

afterEach(cleanup);

describe("CurrencyInput", () => {
  it("asks for a decimal keyboard and a done key", () => {
    render(<CurrencyInput label="Total" />);

    const field = screen.getByLabelText("Total");
    expect(field.getAttribute("inputmode")).toBe("decimal");
    expect(field.getAttribute("enterkeyhint")).toBe("done");
    expect(field.className).toContain("tabular-nums");
    expect(field.className).toContain("text-3xl");
  });

  it("accepts a typed amount", async () => {
    const user = userEvent.setup();
    render(<CurrencyInput label="Total" />);

    const field = screen.getByLabelText("Total");
    await user.type(field, "42.50");
    expect(field).toHaveProperty("value", "42.50");
  });
});

describe("PercentageInput", () => {
  it("asks for a decimal keyboard and a next key", () => {
    render(<PercentageInput label="Service charge" />);

    const field = screen.getByLabelText("Service charge");
    expect(field.getAttribute("inputmode")).toBe("decimal");
    expect(field.getAttribute("enterkeyhint")).toBe("next");
    expect(field.className).toContain("tabular-nums");
  });
});

describe("Checkbox", () => {
  it("toggles with the keyboard and reports its state", async () => {
    const user = userEvent.setup();
    render(<Checkbox label="Email me" />);

    await user.tab();
    const box = screen.getByLabelText("Email me");
    expect(document.activeElement).toBe(box);
    expect(box).toHaveProperty("checked", false);

    await user.keyboard("[Space]");
    expect(box).toHaveProperty("checked", true);
  });

  it("gives the label a 44px minimum target", () => {
    render(<Checkbox label="I agree to the rules" />);

    const label = screen.getByText("I agree to the rules").closest("label");
    expect(label?.className).toContain("min-h-control");
  });

  it("announces its error and stays disabled when asked", () => {
    render(<Checkbox label="I agree" error="You must accept." disabled />);

    expect(screen.getByRole("alert").textContent).toBe("You must accept.");
    const box = screen.getByLabelText("I agree");
    expect(box).toHaveProperty("disabled", true);
    expect(box.getAttribute("aria-describedby")).toBe(
      screen.getByRole("alert").id,
    );
  });
});
