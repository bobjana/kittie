// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../../../src/components/ui/button";

afterEach(cleanup);

describe("Button", () => {
  it("is reachable by keyboard and activates on Enter", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Add expense</Button>);

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Add expense" }),
    );

    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("activates on Space", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Settle up</Button>);

    await user.tab();
    await user.keyboard("[Space]");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Disabled
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Disabled" });
    expect(button).toHaveProperty("disabled", true);

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("reports a busy state while loading and cannot be clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} loading>
        Saving
      </Button>,
    );

    const button = screen.getByRole("button", { name: /Saving/ });
    expect(button.getAttribute("aria-busy")).toBe("true");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("carries the 44px control token, and 52px for the large size", () => {
    render(
      <>
        <Button>Default</Button>
        <Button size="lg">Large</Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Default" }).className).toContain(
      "min-h-control",
    );
    expect(screen.getByRole("button", { name: "Large" }).className).toContain(
      "min-h-button",
    );
  });
});
