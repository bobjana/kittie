// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Amount, formatMinorUnits } from "../../../src/components/ui/amount";
import { Avatar } from "../../../src/components/ui/avatar";
import { Badge } from "../../../src/components/ui/badge";
import { Fab } from "../../../src/components/ui/fab";
import { IconButton } from "../../../src/components/ui/icon-button";
import { Toast } from "../../../src/components/ui/toast";

afterEach(cleanup);

describe("Amount", () => {
  it("formats minor units with two decimals and tabular figures", () => {
    render(<Amount minorUnits={123456} locale="en-US" />);

    const value = screen.getByText(/1,234\.56/);
    expect(value.textContent).toBe("€1,234.56");
    expect(value.className).toContain("tabular-nums");
  });

  it("keeps the sign on negative balances", () => {
    expect(formatMinorUnits(-4599, "EUR", "en-US")).toBe("-€45.99");
  });
});

describe("IconButton", () => {
  it("exposes an accessible name and the 44px control token", () => {
    render(
      <IconButton aria-label="Add a receipt">
        <span aria-hidden="true">+</span>
      </IconButton>,
    );

    const button = screen.getByRole("button", { name: "Add a receipt" });
    expect(button.className).toContain("size-control");
  });

  it("activates from the keyboard", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <IconButton aria-label="Scan receipt" onClick={onClick}>
        <span aria-hidden="true">◎</span>
      </IconButton>,
    );

    await user.tab();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Fab", () => {
  it("is a 64px labelled action", () => {
    render(
      <Fab aria-label="Add expense">
        <span aria-hidden="true">+</span>
      </Fab>,
    );

    const button = screen.getByRole("button", { name: "Add expense" });
    expect(button.className).toContain("size-fab");
  });

  it("does not fire while disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Fab aria-label="Add expense" disabled onClick={onClick}>
        <span aria-hidden="true">+</span>
      </Fab>,
    );

    await user.click(screen.getByRole("button", { name: "Add expense" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Avatar", () => {
  it("renders initials for the person and keeps the name as its label", () => {
    render(<Avatar name="Mara Silva" />);

    const avatar = screen.getByRole("img", { name: "Mara Silva" });
    expect(avatar.textContent).toBe("MS");
  });
});

describe("Badge", () => {
  it("renders its text", () => {
    render(<Badge tone="success">Settled</Badge>);
    expect(screen.getByText("Settled")).toBeTruthy();
  });
});

describe("Toast", () => {
  it("announces politely by default", () => {
    render(<Toast title="Expense saved">Split between 4 people.</Toast>);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("announces errors assertively and can be dismissed", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <Toast tone="error" title="Could not save" onDismiss={onDismiss}>
        Try again.
      </Toast>,
    );

    expect(screen.getByRole("alert").getAttribute("aria-live")).toBe(
      "assertive",
    );

    await user.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
