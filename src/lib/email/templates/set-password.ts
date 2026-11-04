import { emailLayout } from "../layout";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface SetPasswordEmailInput {
  link: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function setPasswordEmail(input: SetPasswordEmailInput): RenderedEmail {
  const subject = "Set your Kittie password";
  const text = `Welcome to Kittie. Set your password here: ${input.link}`;
  const html = emailLayout({
    title: "Set your Kittie password",
    preview: "Set your password to finish signing in.",
    bodyHtml: `
      <p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#241f35;">You asked to sign in to Kittie. Choose a password to finish.</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(input.link)}" style="display:inline-block;background-color:#6d28d9;color:#ffffff;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:999px;">Set password</a>
      </p>
      <p style="margin:0;font-size:14px;line-height:1.5;color:#6d6585;">This link expires in 60 minutes. If you did not ask for it, you can ignore this email.</p>
    `,
  });
  return { subject, html, text };
}
