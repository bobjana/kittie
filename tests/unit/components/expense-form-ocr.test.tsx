// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// The capture component is stubbed at its documented contract (reports busy,
// then the upload result) so these tests isolate the form's OCR integration:
// chip, prefill, dirty tracking, save body and poll lifetime. The real capture
// behaviour is row 15's own concern.
const captured = vi.hoisted(() => ({
  upload: null as null | {
    receiptId: string;
    ocr: { status: string; jobId?: string };
  },
}));

vi.mock("../../../src/components/receipt-capture", () => ({
  ReceiptCapture: ({
    onUploaded,
    onStatusChange,
    disabled,
  }: {
    onUploaded?: (result: unknown) => void;
    onStatusChange?: (status: {
      phase: string;
      errorCode: string | null;
    }) => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        onStatusChange?.({ phase: "busy", errorCode: null });
        if (captured.upload) {
          onUploaded?.(captured.upload);
        }
        onStatusChange?.({ phase: "done", errorCode: null });
      }}
    >
      Add receipt photo
    </button>
  ),
  receiptCaptureErrorMessage: (code: string) => `upload error ${code}`,
}));

import { ExpenseForm } from "../../../src/components/expense-form";
import type { ParticipantOption } from "../../../src/components/participant-picker";
import { OCR_POLL_INTERVAL_MS } from "../../../src/components/use-ocr-job-poll";

const MEMBERS: ParticipantOption[] = [
  { id: "m1", displayName: "Ann", emailNormalized: "ann@example.com" },
  { id: "m2", displayName: "Bob", emailNormalized: "bob@example.com" },
];

const JOB_ID = "job-0000-0000-0000-000000000000";

type JobStep =
  | { kind: "job"; status: string; result: unknown }
  | { kind: "pending" };

const SUCCESS_RESULT = {
  amountMinor: 1250,
  currency: "EUR",
  eventCurrency: "EUR",
  currencyMismatch: false,
  date: "2026-11-04",
  merchant: "Fixture Merchant abcd1234",
};

interface FetchHarness {
  fetchMock: ReturnType<typeof vi.fn>;
  jobCalls: () => number;
  createCalls: () => Array<[string, RequestInit]>;
}

let steps: JobStep[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(): FetchHarness {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/ocr-jobs/")) {
      const step = steps.shift() ?? { kind: "pending" as const };
      if (step.kind === "pending") {
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(
        jsonResponse({
          id: JOB_ID,
          status: step.status,
          attempts: 1,
          result: step.result ?? null,
          errorCode: step.status === "failed" ? "OCR_PROVIDER_FAILED" : null,
          errorMessage: null,
        }),
      );
    }
    if (url.startsWith("/api/receipts")) {
      return Promise.resolve(
        jsonResponse({
          receiptId: "r1",
          ocr: { status: "queued", jobId: JOB_ID },
        }),
      );
    }
    return Promise.resolve(jsonResponse({}, 200));
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    jobCalls: () =>
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).startsWith("/api/ocr-jobs/"),
      ).length,
    createCalls: () =>
      fetchMock.mock.calls.filter(
        (call) => String(call[0]) === "/api/events/e1/expenses",
      ) as Array<[string, RequestInit]>,
  };
}

function renderForm() {
  const view = render(
    <ExpenseForm
      eventId="e1"
      currency="EUR"
      members={MEMBERS}
      currentMemberId="m1"
    />,
  );
  const form = view.container.querySelector("form");
  if (!form) {
    throw new Error("expected the expense form to render a form element");
  }
  return { ...view, form };
}

async function uploadReceipt(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add receipt photo" }));
  });
}

async function advanceToPoll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(OCR_POLL_INTERVAL_MS);
  });
}

function setValue(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  vi.useFakeTimers();
  steps = [];
  captured.upload = {
    receiptId: "r1",
    ocr: { status: "queued", jobId: JOB_ID },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ExpenseForm receipt OCR", () => {
  it("shows uploading then reading, and prefills untouched fields on success", async () => {
    installFetch();
    steps = [{ kind: "job", status: "succeeded", result: SUCCESS_RESULT }];
    renderForm();

    expect(screen.queryByText(/Reading the receipt/)).toBeNull();

    await uploadReceipt();
    expect(screen.getByText(/Reading the receipt/)).toBeTruthy();
    expect(screen.queryByText(/Receipt read\./)).toBeNull();

    await advanceToPoll();

    expect(screen.getByText("Check the receipt values")).toBeTruthy();
    expect(screen.getByText(/Receipt read\./)).toBeTruthy();
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe(
      "12.50",
    );
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe(
      "2026-11-04",
    );
    expect(
      (screen.getByLabelText("Description") as HTMLInputElement).value,
    ).toBe("Fixture Merchant abcd1234");
  });

  it("never overwrites a typed amount but still prefills untouched fields", async () => {
    installFetch();
    steps = [{ kind: "job", status: "succeeded", result: SUCCESS_RESULT }];
    renderForm();

    setValue("Amount", "42.00");
    await uploadReceipt();
    await advanceToPoll();

    expect(screen.getByText("Check the receipt values")).toBeTruthy();
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe(
      "42.00",
    );
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe(
      "2026-11-04",
    );
  });

  it("never overwrites a typed description but still prefills the amount", async () => {
    installFetch();
    steps = [{ kind: "job", status: "succeeded", result: SUCCESS_RESULT }];
    renderForm();

    setValue("Description", "typed by hand");
    await uploadReceipt();
    await advanceToPoll();

    expect(
      (screen.getByLabelText("Description") as HTMLInputElement).value,
    ).toBe("typed by hand");
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe(
      "12.50",
    );
  });

  it("on a currency mismatch it explains the currency and leaves the amount empty", async () => {
    installFetch();
    steps = [
      {
        kind: "job",
        status: "succeeded",
        result: { ...SUCCESS_RESULT, currency: "USD", currencyMismatch: true },
      },
    ];
    renderForm();

    await uploadReceipt();
    await advanceToPoll();

    expect(
      screen.getByText("Receipt is in USD; enter the event-currency amount"),
    ).toBeTruthy();
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe(
      "",
    );
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe(
      "2026-11-04",
    );
  });

  it("on failure it shows the manual fallback and still saves the receipt id", async () => {
    const harness = installFetch();
    steps = [{ kind: "job", status: "failed", result: null }];
    const { form } = renderForm();

    await uploadReceipt();
    await advanceToPoll();

    expect(screen.getByText("Couldn't read it - enter manually")).toBeTruthy();
    expect(screen.queryByText("Check the receipt values")).toBeNull();

    setValue("Amount", "42.00");
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(harness.createCalls().length).toBe(1);

    const body = JSON.parse(String(harness.createCalls()[0][1].body)) as {
      receiptId?: string;
      totalMinor?: number;
    };
    expect(body.receiptId).toBe("r1");
    expect(body.totalMinor).toBe(4200);
  });

  it("does not block saving while the OCR job is still running", async () => {
    installFetch();
    steps = [];
    renderForm();

    setValue("Amount", "42.00");
    await uploadReceipt();

    expect(screen.getByText(/Reading the receipt/)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Save expense",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("stops polling once the job reports a terminal status", async () => {
    const harness = installFetch();
    steps = [{ kind: "job", status: "succeeded", result: SUCCESS_RESULT }];
    renderForm();

    await uploadReceipt();
    await advanceToPoll();
    expect(harness.jobCalls()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OCR_POLL_INTERVAL_MS * 10);
    });
    expect(harness.jobCalls()).toBe(1);
  });

  it("stops polling after unmount without resolving into the gone form", async () => {
    const harness = installFetch();
    steps = [];
    const view = renderForm();

    await uploadReceipt();
    await advanceToPoll();
    expect(harness.jobCalls()).toBe(1);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OCR_POLL_INTERVAL_MS * 10);
    });
    expect(harness.jobCalls()).toBe(1);
  });
});
