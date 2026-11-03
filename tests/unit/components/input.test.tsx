// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Input } from "../../../src/components/ui/input";

afterEach(cleanup);

describe("Input", () => {
  it("associates the label with the field and accepts typing", async () => {
    const user = userEvent.setup();
    render(<Input label="Event name" />);

    const field = screen.getByLabelText("Event name");
    await user.type(field, "Lisbon weekend");
    expect(field).toHaveProperty("value", "Lisbon weekend");
  });

  it("announces an error and marks the field invalid", () => {
    render(
      <Input
        label="Your email"
        defaultValue="nope"
        error="Enter a valid email address."
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Enter a valid email address.");

    const field = screen.getByLabelText("Your email");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("wires the hint only while there is no error", () => {
    const { rerender } = render(
      <Input label="Note" hint="Visible to everyone." />,
    );

    const field = screen.getByLabelText("Note");
    expect(field.getAttribute("aria-describedby")).toBe(
      screen.getByText("Visible to everyone.").id,
    );

    rerender(
      <Input label="Note" hint="Visible to everyone." error="Too long." />,
    );
    expect(screen.queryByText("Visible to everyone.")).toBeNull();
    expect(screen.getByLabelText("Note").getAttribute("aria-describedby")).toBe(
      screen.getByRole("alert").id,
    );
  });

  it("keeps disabled fields out of the tab order", async () => {
    const user = userEvent.setup();
    render(<Input label="Locked" disabled />);

    await user.tab();
    expect(document.activeElement).toBe(document.body);
  });
});
