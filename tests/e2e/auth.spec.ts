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

async function waitForMessage(
  request: APIRequestContext,
  email: string,
): Promise<MailpitMessage> {
  await expect
    .poll(
      async () => {
        const response = await request.get(`${MAILPIT}/api/v1/messages`);
        if (!response.ok()) {
          return false;
        }
        const data = (await response.json()) as { messages?: MailpitMessage[] };
        return (
          data.messages?.some((candidate) =>
            candidate.To?.some(
              (to) => to.Address?.toLowerCase() === email.toLowerCase(),
            ),
          ) ?? false
        );
      },
      { timeout: 20_000, message: `Mailpit message for ${email}` },
    )
    .toBe(true);

  const listResponse = await request.get(`${MAILPIT}/api/v1/messages`);
  const list = (await listResponse.json()) as { messages: MailpitMessage[] };
  const summary = list.messages.find((candidate) =>
    candidate.To?.some(
      (to) => to.Address?.toLowerCase() === email.toLowerCase(),
    ),
  );
  if (!summary) {
    throw new Error(`Mailpit message for ${email} disappeared`);
  }
  const response = await request.get(`${MAILPIT}/api/v1/message/${summary.ID}`);
  return (await response.json()) as MailpitMessage;
}

function resetLinkFromMessage(message: MailpitMessage): URL {
  const body = message.HTML ?? message.Text ?? "";
  const match = /http:\/\/localhost:3100\/welcome\/password\?[^"\s]+/.exec(
    body,
  );
  if (!match) {
    throw new Error("reset link not found in Mailpit message");
  }
  return new URL(match[0].replace(/&amp;/g, "&"));
}

async function countMessages(
  request: APIRequestContext,
  email: string,
): Promise<number> {
  const response = await request.get(`${MAILPIT}/api/v1/messages`);
  const data = (await response.json()) as { messages?: MailpitMessage[] };
  return (
    data.messages?.filter((candidate) =>
      candidate.To?.some(
        (to) => to.Address?.toLowerCase() === email.toLowerCase(),
      ),
    ).length ?? 0
  );
}

test("register, set password, auto-login, sign out, sign in", async ({
  page,
  request,
  context,
  browser,
}) => {
  const email = uniqueEmail("happy");
  const password = "happy-password-1";

  await page.goto("/register");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/check-email/);

  const message = await waitForMessage(request, email);
  const link = resetLinkFromMessage(message);

  await page.goto(link.toString());
  await expect(page.getByText(email)).toBeVisible();
  await page.screenshot({
    path: `${EVIDENCE_DIR}/task-7-group-expense-splitter-register.png`,
    fullPage: true,
  });
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set password and sign in" }).click();

  await expect(page).toHaveURL(/\/tally/);

  const state = await context.storageState();
  const freshContext = await browser.newContext({ storageState: state });
  const sessionResponse = await freshContext.request.get(
    `${APP}/api/auth/get-session`,
  );
  const sessionData = (await sessionResponse.json()) as {
    user?: { email?: string };
  };
  expect(sessionData.user?.email).toBe(email);
  await freshContext.close();

  await context.clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/tally/);
});

test("reusing a consumed reset link fails with 400", async ({ request }) => {
  const email = uniqueEmail("reuse");
  const password = "reuse-password-1";

  await request.post(`${APP}/api/auth/register`, { data: { email } });
  const link = resetLinkFromMessage(await waitForMessage(request, email));
  const token = link.searchParams.get("token");

  const first = await request.post(`${APP}/api/auth/set-password`, {
    data: { token, email, password },
  });
  expect(first.status()).toBe(200);

  const second = await request.post(`${APP}/api/auth/set-password`, {
    data: { token, email, password },
  });
  expect(second.status()).toBe(400);
  expect(await second.json()).toEqual({ ok: false, error: "INVALID_TOKEN" });
});

test("mismatched email on the reset link fails with 400", async ({
  request,
}) => {
  const email = uniqueEmail("owner");
  const password = "owner-password-1";

  await request.post(`${APP}/api/auth/register`, { data: { email } });
  const link = resetLinkFromMessage(await waitForMessage(request, email));
  const token = link.searchParams.get("token");

  const response = await request.post(`${APP}/api/auth/set-password`, {
    data: { token, email: "attacker@example.com", password },
  });
  expect(response.status()).toBe(400);
  expect(await response.json()).toEqual({
    ok: false,
    error: "EMAIL_MISMATCH",
  });
});

test("registration throttle returns 200 but sends no new email", async ({
  request,
}) => {
  const email = uniqueEmail("throttle");
  const limit = 5;

  for (let attempt = 0; attempt < limit; attempt += 1) {
    const response = await request.post(`${APP}/api/auth/register`, {
      data: { email },
    });
    expect(response.status()).toBe(200);
  }

  await expect
    .poll(() => countMessages(request, email), { timeout: 20_000 })
    .toBe(limit);

  const throttled = await request.post(`${APP}/api/auth/register`, {
    data: { email },
  });
  expect(throttled.status()).toBe(200);
  expect(await throttled.json()).toEqual({ ok: true });

  await expect
    .poll(() => countMessages(request, email), { timeout: 10_000 })
    .toBe(limit);
});
