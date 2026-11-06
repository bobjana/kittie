import { describe, expect, it } from "vitest";

import {
  buildTallyLink,
  type CloseTallyEmailInput,
  closeTallyEmail,
  closeTallySubject,
} from "@/lib/email/templates/close-tally";

const APP_URL = "https://app.example.com";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function makeInput(
  overrides: Partial<CloseTallyEmailInput> = {},
): CloseTallyEmailInput {
  return {
    eventName: "Lisbon",
    version: 1,
    currency: "EUR",
    closedAt: "2026-11-05T10:00:00.000Z",
    totalSpentMinor: 40000,
    members: [
      {
        memberId: "member-a",
        label: "Ana",
        paidMinor: 30000,
        shareMinor: 20000,
        netMinor: 10000,
      },
      {
        memberId: "member-b",
        label: "Bruno",
        paidMinor: 10000,
        shareMinor: 20000,
        netMinor: -10000,
      },
    ],
    transfers: [
      { fromMemberId: "member-b", toMemberId: "member-a", amountMinor: 10000 },
    ],
    recipientMemberId: "member-a",
    link: `${APP_URL}/events/${EVENT_ID}/report`,
    ...overrides,
  };
}

describe("closeTallySubject", () => {
  it("uses the final-tally subject on the first close", () => {
    expect(closeTallySubject("Lisbon", 1)).toBe("Final tally: Lisbon");
  });

  it("uses the updated-tally subject after a reopen and re-close", () => {
    expect(closeTallySubject("Lisbon", 2)).toBe("Updated final tally: Lisbon");
    expect(closeTallySubject("Lisbon", 7)).toBe("Updated final tally: Lisbon");
  });
});

describe("buildTallyLink", () => {
  it("links an active member straight to the frozen report", () => {
    const link = buildTallyLink(APP_URL, "active", EVENT_ID, "ana@example.com");
    expect(link).toBe(`${APP_URL}/events/${EVENT_ID}/report`);
  });

  it("links a pending member through the register flow with the invited email", () => {
    const link = buildTallyLink(
      APP_URL,
      "pending",
      EVENT_ID,
      "ana+invite@example.com",
    );
    const parsed = new URL(link);
    expect(parsed.origin + parsed.pathname).toBe(`${APP_URL}/register`);
    expect(parsed.searchParams.get("email")).toBe("ana+invite@example.com");
    expect(parsed.searchParams.get("next")).toBe(`/events/${EVENT_ID}/report`);
  });

  it("encodes the pending email and next path safely in the raw URL", () => {
    const link = buildTallyLink(
      APP_URL,
      "pending",
      EVENT_ID,
      "ana+invite@example.com",
    );
    expect(link).toContain(
      `email=ana%2Binvite%40example.com&next=${encodeURIComponent(`/events/${EVENT_ID}/report`)}`,
    );
  });
});

describe("closeTallyEmail", () => {
  it("renders the group total, closed date and per-member amounts", () => {
    const email = closeTallyEmail(makeInput());

    expect(email.text).toContain(
      "Lisbon closed on 2026-11-05T10:00:00.000Z. Group total: EUR 400.00.",
    );
    expect(email.text).toContain(
      "Ana: paid EUR 300.00, share EUR 200.00, net EUR 100.00.",
    );
    expect(email.text).toContain(
      "Bruno: paid EUR 100.00, share EUR 200.00, net EUR -100.00.",
    );
    expect(email.html).toContain("EUR 400.00");
    expect(email.html).toContain("paid EUR 300.00");
    expect(email.html).toContain("share EUR 200.00");
  });

  it("renders who-pays-whom transfer lines", () => {
    const email = closeTallyEmail(makeInput());

    expect(email.text).toContain("Bruno pays Ana EUR 100.00");
    expect(email.html).toContain("Bruno pays Ana EUR 100.00");
    expect(email.html).toContain("Who pays whom:");
  });

  it("tells a settled-up group that no transfers are needed", () => {
    const email = closeTallyEmail(
      makeInput({
        members: [
          {
            memberId: "member-a",
            label: "Ana",
            paidMinor: 20000,
            shareMinor: 20000,
            netMinor: 0,
          },
        ],
        transfers: [],
      }),
    );

    expect(email.text).toContain(
      "Ana: paid EUR 200.00, share EUR 200.00, net EUR 0.00.",
    );
    expect(email.html).toContain(
      "Everyone is settled up - no transfers needed.",
    );
    expect(email.html).toContain("settled");
    expect(email.html).not.toContain("Who pays whom:");
  });

  it("summarizes the recipient's own position", () => {
    const owed = closeTallyEmail(makeInput({ recipientMemberId: "member-b" }));
    expect(owed.html).toContain("You owe <strong>EUR 100.00</strong>");

    const getsBack = closeTallyEmail(
      makeInput({ recipientMemberId: "member-a" }),
    );
    expect(getsBack.html).toContain("You get back <strong>EUR 100.00</strong>");

    const settled = closeTallyEmail(
      makeInput({
        recipientMemberId: "member-c",
        members: [
          ...makeInput().members,
          {
            memberId: "member-c",
            label: "Cleo",
            paidMinor: 0,
            shareMinor: 0,
            netMinor: 0,
          },
        ],
      }),
    );
    expect(settled.html).toContain("You are settled up.");
  });

  it("falls back to Removed member for transfer participants not in the snapshot", () => {
    const email = closeTallyEmail(
      makeInput({
        transfers: [
          {
            fromMemberId: "member-b",
            toMemberId: "member-gone",
            amountMinor: 5000,
          },
        ],
      }),
    );

    expect(email.text).toContain("Bruno pays Removed member EUR 50.00");
  });

  it("escapes member names and the event name in the html body", () => {
    const email = closeTallyEmail(
      makeInput({
        eventName: 'Lisbon <script>alert("x")</script>',
        members: [
          {
            memberId: "member-a",
            label: "Ana <b>& Co</b>",
            paidMinor: 30000,
            shareMinor: 20000,
            netMinor: 10000,
          },
        ],
        transfers: [],
      }),
    );

    expect(email.html).toContain(
      "Lisbon &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(email.html).toContain("Ana &lt;b&gt;&amp; Co&lt;/b&gt;");
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<b>");
  });

  it("keeps receipts, tokens and secrets out of the body", () => {
    const pending = closeTallyEmail(
      makeInput({
        link: `${APP_URL}/register?email=ana%40example.com&next=%2Fevents%2F${EVENT_ID}%2Freport`,
      }),
    );

    expect(pending.html).not.toContain("token=");
    expect(pending.html).not.toContain("secret");
    expect(pending.text).not.toContain("token=");
    expect(pending.text).not.toContain("secret");
  });

  it("links the report at the end of the text body", () => {
    const email = closeTallyEmail(makeInput());
    expect(email.text).toContain(
      `See the full report: ${APP_URL}/events/${EVENT_ID}/report`,
    );
  });
});
