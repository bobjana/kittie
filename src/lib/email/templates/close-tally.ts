import { emailLayout } from "../layout";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface CloseTallyEmailMember {
  memberId: string;
  label: string;
  paidMinor: number;
  shareMinor: number;
  netMinor: number;
}

export interface CloseTallyEmailTransfer {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
}

export interface CloseTallyEmailInput {
  eventName: string;
  /** Version > 1 means the event was closed again after a reopen. */
  version: number;
  currency: string;
  closedAt: string;
  totalSpentMinor: number;
  members: CloseTallyEmailMember[];
  transfers: CloseTallyEmailTransfer[];
  recipientMemberId: string;
  /**
   * The personalized link for this recipient: active members go straight to
   * the frozen report, pending members land on the register flow, which
   * links the pending membership by email afterwards.
   */
  link: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildTallyLink(
  appUrl: string,
  memberStatus: string,
  eventId: string,
  recipientEmail: string,
): string {
  if (memberStatus === "pending") {
    const params = new URLSearchParams({
      email: recipientEmail,
      next: `/events/${eventId}/report`,
    });
    return `${appUrl}/register?${params.toString()}`;
  }
  return `${appUrl}/events/${eventId}/report`;
}

export function closeTallySubject(eventName: string, version: number): string {
  return version > 1
    ? `Updated final tally: ${eventName}`
    : `Final tally: ${eventName}`;
}

function formatMinor(minor: number, currency: string): string {
  const amount = (minor / 100).toFixed(2);
  return `${currency} ${amount}`;
}

function transferLine(
  input: CloseTallyEmailInput,
  transfer: CloseTallyEmailTransfer,
): string {
  const nameByMemberId = new Map(
    input.members.map((member) => [member.memberId, member.label]),
  );
  const from = nameByMemberId.get(transfer.fromMemberId) ?? "Removed member";
  const to = nameByMemberId.get(transfer.toMemberId) ?? "Removed member";
  return `${escapeHtml(from)} pays ${escapeHtml(to)} ${escapeHtml(
    formatMinor(transfer.amountMinor, input.currency),
  )}`;
}

export function closeTallyEmail(input: CloseTallyEmailInput): RenderedEmail {
  const subject = closeTallySubject(input.eventName, input.version);
  const money = (minor: number) => formatMinor(minor, input.currency);

  const memberRows = input.members
    .map((member) => {
      const net =
        member.netMinor === 0
          ? "settled"
          : `${member.netMinor > 0 ? "gets back" : "owes"} ${escapeHtml(
              money(Math.abs(member.netMinor)),
            )}`;
      return `
      <tr>
        <td style="padding:8px 12px;font-size:14px;color:#241f35;border-bottom:1px solid #f0ebfa;">${escapeHtml(member.label)}</td>
        <td style="padding:8px 12px;font-size:14px;color:#241f35;border-bottom:1px solid #f0ebfa;text-align:right;">paid ${escapeHtml(money(member.paidMinor))}</td>
        <td style="padding:8px 12px;font-size:14px;color:#241f35;border-bottom:1px solid #f0ebfa;text-align:right;">share ${escapeHtml(money(member.shareMinor))}</td>
        <td style="padding:8px 12px;font-size:14px;font-weight:600;color:#241f35;border-bottom:1px solid #f0ebfa;text-align:right;">${net}</td>
      </tr>`;
    })
    .join("");

  const transferList = input.transfers.length
    ? `
      <p style="margin:0 0 12px;font-size:16px;line-height:1.5;color:#241f35;">Who pays whom:</p>
      <ul style="margin:0 0 24px;padding:0 0 0 18px;">
        ${input.transfers
          .map(
            (transfer) =>
              `<li style="margin:0 0 6px;font-size:14px;line-height:1.5;color:#241f35;">${transferLine(input, transfer)}</li>`,
          )
          .join("")}
      </ul>`
    : `<p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#6d6585;">Everyone is settled up - no transfers needed.</p>`;

  const recipient = input.members.find(
    (member) => member.memberId === input.recipientMemberId,
  );
  const recipientSummary = recipient
    ? recipient.netMinor === 0
      ? `<p style="margin:0 0 20px;font-size:16px;line-height:1.5;color:#241f35;">You are settled up.</p>`
      : recipient.netMinor > 0
        ? `<p style="margin:0 0 20px;font-size:16px;line-height:1.5;color:#241f35;">You get back <strong>${escapeHtml(money(recipient.netMinor))}</strong>.</p>`
        : `<p style="margin:0 0 20px;font-size:16px;line-height:1.5;color:#241f35;">You owe <strong>${escapeHtml(money(Math.abs(recipient.netMinor)))}</strong>.</p>`
    : "";

  const textLines = [
    `${subject}.`,
    `${input.eventName} closed on ${input.closedAt}. Group total: ${money(input.totalSpentMinor)}.`,
    ...input.members.map(
      (member) =>
        `${member.label}: paid ${money(member.paidMinor)}, share ${money(member.shareMinor)}, net ${money(member.netMinor)}.`,
    ),
    ...input.transfers.map((transfer) => `${transferLine(input, transfer)}`),
    `See the full report: ${input.link}`,
  ];

  const html = emailLayout({
    title: subject,
    preview: `${input.eventName} closed. Group total ${money(input.totalSpentMinor)}.`,
    bodyHtml: `
      <p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#241f35;"><strong>${escapeHtml(input.eventName)}</strong> closed on ${escapeHtml(input.closedAt)}. The final tally is frozen.</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.5;color:#241f35;">Group total: <strong>${escapeHtml(money(input.totalSpentMinor))}</strong>.</p>
      ${recipientSummary}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr>
          <th align="left" style="padding:8px 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#6d6585;border-bottom:2px solid #e7e0f5;">Member</th>
          <th align="right" style="padding:8px 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#6d6585;border-bottom:2px solid #e7e0f5;">Paid</th>
          <th align="right" style="padding:8px 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#6d6585;border-bottom:2px solid #e7e0f5;">Share</th>
          <th align="right" style="padding:8px 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#6d6585;border-bottom:2px solid #e7e0f5;">Net</th>
        </tr>
        ${memberRows}
      </table>
      ${transferList}
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background-color:#6d28d9;color:#ffffff;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:999px;">Open the report</a>
      </p>
      <p style="margin:0;font-size:14px;line-height:1.5;color:#6d6585;">This email never contains receipts or payment details - only the final tally. If you were not expecting it, you can ignore it.</p>
    `,
  });

  return { subject, html, text: textLines.join("\n") };
}
