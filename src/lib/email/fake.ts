import type { EmailDriver, EmailMessage } from "./service";

export interface FakeEmail extends EmailMessage {
  sentAt: Date;
}

const sent: FakeEmail[] = [];

export const fakeDriver: EmailDriver = {
  async send(message: EmailMessage): Promise<void> {
    sent.push({ ...message, sentAt: new Date() });
  },
};

export function getSentEmails(): readonly FakeEmail[] {
  return sent;
}

export function clearSentEmails(): void {
  sent.length = 0;
}

export function lastEmail(): FakeEmail | undefined {
  return sent[sent.length - 1];
}
