// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryStatus } from "../../../src/components/report/delivery-status";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as Response;
}

interface JobFixture {
  id: string;
  recipientEmail: string;
  displayName: string | null;
  status: "queued" | "running" | "sent" | "failed" | "cancelled";
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: string | null;
}

function job(overrides: Partial<JobFixture>): JobFixture {
  return {
    id: "job-1",
    recipientEmail: "ana@example.com",
    displayName: "Ana",
    status: "sent",
    attempts: 1,
    errorCode: null,
    errorMessage: null,
    sentAt: "2026-11-05T10:00:00.000Z",
    ...overrides,
  };
}

const NOTIFICATIONS_PATH =
  "/api/events/event-1/settlements/settlement-1/notifications";
const RESEND_PATH = `${NOTIFICATIONS_PATH}/resend`;

function installFetch(notifications: JobFixture[]) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === RESEND_PATH) {
      expect(init?.method).toBe("POST");
      return Promise.resolve(jsonResponse({ notification: notifications[0] }));
    }
    if (url === NOTIFICATIONS_PATH) {
      return Promise.resolve(jsonResponse({ notifications }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("DeliveryStatus", () => {
  it("shows the per-member delivery state for a frozen settlement", async () => {
    const fetchMock = installFetch([
      job({}),
      job({
        id: "job-2",
        recipientEmail: "bruno@example.com",
        displayName: "Bruno",
        status: "failed",
        attempts: 3,
        errorCode: "EMAIL_SEND_FAILED",
        errorMessage: "smtp relay unreachable",
        sentAt: null,
      }),
      job({
        id: "job-3",
        recipientEmail: "pending@example.com",
        displayName: null,
        status: "queued",
        attempts: 0,
        sentAt: null,
      }),
    ]);

    render(<DeliveryStatus eventId="event-1" settlementId="settlement-1" />);

    expect(await screen.findByText("Ana")).toBeTruthy();
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText("smtp relay unreachable")).toBeTruthy();
    expect(screen.getByText("pending@example.com")).toBeTruthy();

    expect(String(fetchMock.mock.calls[0][0])).toBe(NOTIFICATIONS_PATH);
  });

  it("resends only a failed email and reloads the list afterwards", async () => {
    const fetchMock = installFetch([
      job({
        id: "job-2",
        displayName: "Bruno",
        status: "failed",
        attempts: 3,
        errorCode: "EMAIL_SEND_FAILED",
        sentAt: null,
      }),
    ]);

    render(<DeliveryStatus eventId="event-1" settlementId="settlement-1" />);

    const resend = await screen.findByRole("button", { name: "Resend" });
    fireEvent.click(resend);

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        (call) => String(call[0]) === RESEND_PATH,
      );
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String(posts[0][1]?.body))).toEqual({
        jobId: "job-2",
      });
    });

    await waitFor(() => {
      const loads = fetchMock.mock.calls.filter(
        (call) => String(call[0]) === NOTIFICATIONS_PATH,
      );
      expect(loads).toHaveLength(2);
    });
  });

  it("offers no resend control when nothing failed", async () => {
    installFetch([job({})]);

    render(<DeliveryStatus eventId="event-1" settlementId="settlement-1" />);

    expect(await screen.findByText("Ana")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resend" })).toBeNull();
  });

  it("explains an empty settlement and a failed status load", async () => {
    installFetch([]);
    render(<DeliveryStatus eventId="event-1" settlementId="settlement-1" />);
    expect(
      await screen.findByText(
        "No tally emails were queued for this settlement.",
      ),
    ).toBeTruthy();
    cleanup();

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({}, 403))),
    );
    render(<DeliveryStatus eventId="event-1" settlementId="settlement-1" />);
    expect(
      await screen.findByText("Could not load the tally email status."),
    ).toBeTruthy();
  });
});
