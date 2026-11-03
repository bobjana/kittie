// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog } from "../../../src/components/ui/dialog";

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Delete expense
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Delete this expense?"
        description="Everyone in the event will see it disappear."
        footer={
          <>
            <button type="button" onClick={() => setOpen(false)}>
              Keep expense
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              Confirm
            </button>
          </>
        }
      >
        <input aria-label="Reason" />
      </Dialog>
    </>
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole("button", { name: "Delete expense" });
  await user.click(trigger);
  return trigger;
}

describe("Dialog", () => {
  it("is labelled by its title and traps initial focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.queryByRole("dialog")).toBeNull();

    await openDialog(user);

    expect(
      screen.getByRole("dialog", { name: "Delete this expense?" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Reason"));
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = await openDialog(user);
    expect(document.activeElement).not.toBe(trigger);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when the close action runs and restores focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("wraps Tab from the last control back to the first", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await openDialog(user);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Confirm" }),
    );

    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Reason"));

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Confirm" }),
    );
  });
});
