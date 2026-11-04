import { Resend } from "resend";
import { env } from "@/lib/env";
import type { EmailDriver, EmailMessage } from "./service";

let resend: Resend | undefined;

function getResend(): Resend {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is required when EMAIL_DRIVER=resend");
  }
  resend ??= new Resend(env.RESEND_API_KEY);
  return resend;
}

export const resendDriver: EmailDriver = {
  async send(message: EmailMessage): Promise<void> {
    await getResend().emails.send({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  },
};
