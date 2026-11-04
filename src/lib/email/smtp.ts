import type { Transporter } from "nodemailer";
import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import type { EmailDriver, EmailMessage } from "./service";

let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (!env.SMTP_URL) {
    throw new Error("SMTP_URL is required when EMAIL_DRIVER=smtp");
  }
  transporter ??= nodemailer.createTransport(env.SMTP_URL);
  return transporter;
}

export const smtpDriver: EmailDriver = {
  async send(message: EmailMessage): Promise<void> {
    await getTransporter().sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  },
};
