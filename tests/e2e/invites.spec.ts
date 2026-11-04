import { type APIRequestContext, expect, test } from "@playwright/test";

const APP = "http://localhost:3100";
const MAILPIT = "http://localhost:8025";
const EVIDENCE_DIR = "/Users/dviljoen/Projects/kittie/.omo/evidence";

interface MailpitAddress {
  Address?: string;
}

interface MailpitMessage {
  ID: string;
  To?: MailpitAddress[];
  Text?: string;
  HTML?: string;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function listMessages(
  request: APIRequestContext,
): Promise<MailpitMessage[]> {
  const response = await request.get(`${MAILPIT}/api/v1/messages`);
  if (!response.ok()) {
    return [];
  }
  const data = (await response.json()) as { messages?: MailpitMessage[] };
  return data.messages ?? [];
}

function toAddress(message: MailpitMessage, email: string): boolean {
  return (
    message.To?.some(
      (to) => to.Address?.toLowerCase() === email.toLowerCase(),
    ) ?? false
  );
}

async function waitForMessage(
  request: APIRequestContext,
  email: string,
): Promise<MailpitMessage> {
  await expect
    .poll(
      async () =>
        (await listMessages(request)).some((m) => toAddress(m, email)),
      { timeout: 20_000, message: `Mailpit message for ${email}` },
    )
    .toBe(true);

  const summary = (await listMessages(request)).find((m) =>
    toAddress(m, email),
  );
  if (!summary) {
    throw new Error(`Mailpit message for ${email} disappeared`);
  }
  const response = await request.get(`${MAILPIT}/api/v1/message/${summary.ID}`);
  return (await response.json()) as MailpitMessage;
}

function bodyOf(message: MailpitMessage): string {
  return message.HTML ?? message.Text ?? "";
}

function inviteLinkFromMessage(message: MailpitMessage): URL {
  const match = /http:\/\/localhost:3100\/invite\/[A-Za-z0-9_-]+/.exec(
    bodyOf(message),
  );
  if (!match) {
    throw new Error("invite link not found in Mailpit message");
  }
  return new URL(match[0]);
}

function resetLinkFromMessage(message: MailpitMessage): URL {
  const match = /http:\/\/localhost:3100\/welcome\/password\?[^"\s]+/.exec(
    bodyOf(message),
  );
  if (!match) {
    throw new Error("reset link not found in Mailpit message");
  }
  return new URL(match[0].replace(/&amp;/g, "&"));
}

async function waitForResetLink(
  request: APIRequestContext,
  email: string,
): Promise<URL> {
  let found: MailpitMessage | null = null;
  await expect
    .poll(
      async () => {
        const messages = await listMessages(request);
        for (const summary of messages) {
          if (!toAddress(summary, email)) continue;
          const response = await request.get(
            `${MAILPIT}/api/v1/message/${summary.ID}`,
          );
          if (!response.ok()) continue;
          const message = (await response.json()) as MailpitMessage;
          if (/\/welcome\/password\?/.test(bodyOf(message))) {
            found = message;
            return true;
          }
        }
        return false;
      },
      { timeout: 20_000, message: `reset link for ${email}` },
    )
    .toBe(true);

  if (!found) {
    throw new Error(`reset link for ${email} disappeared`);
  }
  return resetLinkFromMessage(found);
}

test("organizer invites a friend who registers, auto-joins, and lands on the event", async ({
  page,
  request,
  context,
  browser,
}) => {
  const organizerEmail = uniqueEmail("organizer");
  const friendEmail = uniqueEmail("friend");
  const password = "invite-password-1";
  const eventName = "Wave2 Trip";

  await context.request.post(`${APP}/api/auth/register`, {
    data: { email: organizerEmail },
  });
  const organizerReset = resetLinkFromMessage(
    await waitForMessage(request, organizerEmail),
  );
  const organizerToken = organizerReset.searchParams.get("token");
  const setPassword = await context.request.post(
    `${APP}/api/auth/set-password`,
    {
      data: { token: organizerToken, email: organizerEmail, password },
    },
  );
  expect(setPassword.status()).toBe(200);

  const sessionCheck = await context.request.get(`${APP}/api/auth/get-session`);
  expect(
    ((await sessionCheck.json()) as { user?: { email?: string } }).user?.email,
  ).toBe(organizerEmail);

  const create = await context.request.post(`${APP}/api/events`, {
    data: { name: eventName },
  });
  expect(create.status()).toBe(201);
  const { event } = (await create.json()) as { event: { id: string } };

  await page.goto(`/events/${event.id}/members`);
  await page.getByLabel("Email address").fill(friendEmail);
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByText(friendEmail).first()).toBeVisible();
  await page.screenshot({
    path: `${EVIDENCE_DIR}/task-10-group-expense-splitter-invite.png`,
    fullPage: true,
  });

  const inviteMessage = await waitForMessage(request, friendEmail);
  const messagesToFriend = (await listMessages(request)).filter((m) =>
    toAddress(m, friendEmail),
  );
  expect(messagesToFriend).toHaveLength(1);

  const inviteLink = inviteLinkFromMessage(inviteMessage);

  const friendContext = await browser.newContext();
  const friendPage = await friendContext.newPage();

  await friendPage.goto(inviteLink.toString());
  await expect(friendPage).toHaveURL(/\/register/);
  await friendPage.getByLabel("Email", { exact: true }).fill(friendEmail);
  await friendPage.getByRole("button", { name: "Continue" }).click();
  await expect(friendPage).toHaveURL(/\/check-email/);

  const friendReset = await waitForResetLink(request, friendEmail);
  await friendPage.goto(friendReset.toString());
  await friendPage.getByLabel("Password", { exact: true }).fill(password);
  await friendPage
    .getByLabel("Confirm password", { exact: true })
    .fill(password);
  await friendPage
    .getByRole("button", { name: "Set password and sign in" })
    .click();

  await expect(friendPage).toHaveURL(new RegExp(`/events/${event.id}$`));
  await expect(
    friendPage.getByRole("heading", { name: eventName }),
  ).toBeVisible();

  await friendContext.close();
});
