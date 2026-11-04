import { type APIRequestContext, expect, test } from "@playwright/test";
import postgres from "postgres";
import { loadEnv } from "vite";

const APP = "http://localhost:3100";
const MAILPIT = "http://localhost:8025";
const EVIDENCE_DIR = "/Users/dviljoen/Projects/kittie/.omo/evidence";

interface MailpitMessage {
  ID: string;
  To?: Array<{ Address?: string }>;
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
  const forEmail = (candidate: MailpitMessage) =>
    candidate.To?.some(
      (to) => to.Address?.toLowerCase() === email.toLowerCase(),
    ) ?? false;

  await expect
    .poll(
      async () => {
        const response = await request.get(`${MAILPIT}/api/v1/messages`);
        if (!response.ok()) return false;
        const data = (await response.json()) as { messages?: MailpitMessage[] };
        return data.messages?.some(forEmail) ?? false;
      },
      { timeout: 20_000, message: `Mailpit message for ${email}` },
    )
    .toBe(true);

  const listResponse = await request.get(`${MAILPIT}/api/v1/messages`);
  const list = (await listResponse.json()) as { messages: MailpitMessage[] };
  const summary = list.messages.find(forEmail);
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

test("removes a member who never spent and blocks a payer and self-removal", async ({
  page,
  request,
  context,
}) => {
  const env = loadEnv("test", process.cwd(), "");
  const dbUrl = env.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is required for the members e2e fixture");
  }
  const sql = postgres(dbUrl, { max: 1 });

  try {
    const organizerEmail = uniqueEmail("members-organizer");
    const friendEmail = uniqueEmail("members-friend");
    const payerEmail = uniqueEmail("members-payer");
    const password = "member-password-1";
    const eventName = `Members QA ${Date.now()}`;

    await context.request.post(`${APP}/api/auth/register`, {
      data: { email: organizerEmail },
    });
    const resetLink = resetLinkFromMessage(
      await waitForMessage(request, organizerEmail),
    );
    const setPassword = await context.request.post(
      `${APP}/api/auth/set-password`,
      {
        data: {
          token: resetLink.searchParams.get("token"),
          email: organizerEmail,
          password,
        },
      },
    );
    expect(setPassword.status()).toBe(200);

    const create = await context.request.post(`${APP}/api/events`, {
      data: { name: eventName },
    });
    expect(create.status()).toBe(201);
    const { event } = (await create.json()) as { event: { id: string } };

    const organizerRows = await sql<Array<{ id: string }>>`
      select id from event_members where event_id = ${event.id} and role = 'organizer'
    `;
    const organizerMemberId = organizerRows[0].id;

    const friendRows = await sql<Array<{ id: string }>>`
      insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at)
      values (${event.id}, ${"11111111-1111-4111-8111-111111111111"}, ${friendEmail}, 'Friend One', 'member', 'active', now())
      returning id
    `;
    const friendMemberId = friendRows[0].id;

    const payerRows = await sql<Array<{ id: string }>>`
      insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at)
      values (${event.id}, ${"22222222-2222-4222-8222-222222222222"}, ${payerEmail}, 'Dinner Payer', 'member', 'active', now())
      returning id
    `;
    const payerMemberId = payerRows[0].id;

    const expenseRows = await sql<Array<{ id: string }>>`
      insert into expenses (event_id, created_by, paid_by_member_id, total_minor, currency, spent_on, description, split_mode, status)
      values (${event.id}, ${organizerMemberId}, ${payerMemberId}, 9000, 'EUR', '2026-11-04', 'Dinner', 'equal', 'open')
      returning id
    `;
    await sql`
      insert into expense_participants (expense_id, member_id, personal_minor)
      values (${expenseRows[0].id}, ${payerMemberId}, 0), (${expenseRows[0].id}, ${organizerMemberId}, 0)
    `;

    const pendingEmail = uniqueEmail("members-pending");
    const pendingRows = await sql<Array<{ id: string }>>`
      insert into event_members (event_id, user_id, email_normalized, display_name, role, status)
      values (${event.id}, null, ${pendingEmail}, 'Pending Person', 'member', 'pending')
      returning id
    `;
    const pendingMemberId = pendingRows[0].id;
    await sql`
      insert into event_invites (event_id, member_id, token_hash, email_normalized, expires_at, created_by)
      values (${event.id}, ${pendingMemberId}, ${crypto.randomUUID()}, ${pendingEmail}, now() + interval '7 days', ${organizerMemberId})
    `;

    await page.goto(`/events/${event.id}/members`);
    await expect(page.getByText("Friend One")).toBeVisible();
    await expect(page.getByText("Dinner Payer")).toBeVisible();
    await expect(page.getByText("Pending Person")).toBeVisible();

    await page.getByRole("button", { name: "Remove Friend One" }).click();
    await expect(
      page.getByRole("heading", { name: "Remove member?" }),
    ).toBeVisible();
    await page.screenshot({
      path: `${EVIDENCE_DIR}/task-11-group-expense-splitter-remove-confirm.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Remove member" }).click();
    await expect(page.getByText("Friend One")).toHaveCount(0);

    await page.getByRole("button", { name: "Remove Dinner Payer" }).click();
    await page.getByRole("button", { name: "Remove member" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "This member has expenses in this event",
    );
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Revoke Pending Person" }).click();
    await expect(
      page.getByRole("heading", { name: "Revoke invite?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Revoke invite" }).click();
    await expect(page.getByText("Pending Person")).toHaveCount(0);

    const selfRemoval = await context.request.delete(
      `${APP}/api/events/${event.id}/members/${organizerMemberId}`,
    );
    expect(selfRemoval.status()).toBe(409);
    expect(((await selfRemoval.json()) as { error: string }).error).toBe(
      "CANNOT_REMOVE_SELF",
    );

    const friendStatus = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${friendMemberId}
    `;
    expect(friendStatus[0].status).toBe("removed");
    const payerStatus = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${payerMemberId}
    `;
    expect(payerStatus[0].status).toBe("active");
    const organizerStatus = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${organizerMemberId}
    `;
    expect(organizerStatus[0].status).toBe("active");
    const pendingStatus = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${pendingMemberId}
    `;
    expect(pendingStatus[0].status).toBe("removed");

    await page.screenshot({
      path: `${EVIDENCE_DIR}/task-11-group-expense-splitter-members.png`,
      fullPage: true,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
});
