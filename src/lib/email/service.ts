import { env } from "@/lib/env";
import { fakeDriver } from "./fake";
import { resendDriver } from "./resend";
import { smtpDriver } from "./smtp";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailDriver {
  send(message: EmailMessage): Promise<void>;
}

export function emailDriver(): EmailDriver {
  switch (env.EMAIL_DRIVER) {
    case "resend":
      return resendDriver;
    case "smtp":
      return smtpDriver;
    case "fake":
      return fakeDriver;
  }
}
