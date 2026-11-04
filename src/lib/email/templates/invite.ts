import { emailLayout } from "../layout";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface InviteEmailInput {
  eventName: string;
  organizerName: string | null;
  link: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function inviteEmail(input: InviteEmailInput): RenderedEmail {
  const subject = `You're invited to ${input.eventName} on Kittie`;
  const text = `${input.organizerName ?? "A friend"} invited you to split expenses for "${input.eventName}" on Kittie. Accept the invite here: ${input.link}`;
  const html = emailLayout({
    title: `Join ${input.eventName} on Kittie`,
    preview: `You're invited to ${input.eventName} on Kittie.`,
    bodyHtml: `
      <p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#241f35;">${escapeHtml(input.organizerName ?? "A friend")} invited you to split expenses for <strong>${escapeHtml(input.eventName)}</strong>.</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background-color:#6d28d9;color:#ffffff;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:999px;">Accept invite</a>
      </p>
      <p style="margin:0;font-size:14px;line-height:1.5;color:#6d6585;">This invite expires in 7 days. If you were not expecting it, you can ignore this email.</p>
    `,
  });
  return { subject, html, text };
}
