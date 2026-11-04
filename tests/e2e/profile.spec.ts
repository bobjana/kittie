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

test("profile round trip: update name, change password, sign out, sign in", async ({
  page,
  request,
  context,
}) => {
  const email = uniqueEmail("profile");
  const originalPassword = "profile-original-1";
  const newPassword = "profile-updated-1";

  await request.post(`${APP}/api/auth/register`, { data: { email } });
  const link = resetLinkFromMessage(await waitForMessage(request, email));
  const token = link.searchParams.get("token");
  const setPassword = await request.post(`${APP}/api/auth/set-password`, {
    data: { token, email, password: originalPassword },
  });
  expect(setPassword.status()).toBe(200);

  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(originalPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/tally/);

  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(email);

  await page.getByLabel("Display name").fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Enter a display name.")).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveAttribute(
    "aria-invalid",
    "true",
  );

  const displayName = `Profile ${Date.now()}`;
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Display name updated.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Display name")).toHaveValue(displayName);

  await page.getByLabel("Current password").fill("not-the-password");
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("Current password is incorrect.")).toBeVisible();

  await page.getByLabel("Current password").fill(originalPassword);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(
    page.getByText("Password updated. Your other sessions were signed out."),
  ).toBeVisible();

  await page.screenshot({
    path: `${EVIDENCE_DIR}/task-8-group-expense-splitter-profile.png`,
    fullPage: true,
  });

  await page.reload();
  await expect(page).toHaveURL(/\/profile/);
  await expect(page.getByLabel("Display name")).toHaveValue(displayName);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();

  await expect
    .poll(async () => {
      const sessionCookies = await context.cookies();
      return sessionCookies.filter(
        (cookie) => cookie.name.includes("session_token") && cookie.value,
      ).length;
    })
    .toBe(0);

  const signedOutSession = await request.get(`${APP}/api/auth/get-session`);
  expect(await signedOutSession.json()).toBeNull();

  const loginForm = page.locator("form").filter({ hasText: "Welcome back" });
  await loginForm.getByLabel("Email", { exact: true }).fill(email);
  await loginForm
    .getByLabel("Password", { exact: true })
    .fill(originalPassword);
  await loginForm.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is incorrect")).toBeVisible();

  await loginForm.getByLabel("Password", { exact: true }).fill(newPassword);
  await loginForm.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/tally/);

  await page.goto("/profile");
  await expect(page.getByLabel("Display name")).toHaveValue(displayName);
});
