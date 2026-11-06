import { writeFile } from "node:fs/promises";
import postgres from "postgres";

const APP = "http://localhost:3200";
const MAILPIT = "http://localhost:8025";
const DB = "postgres://kittie:kittie@localhost:5433/kittie_r19_qa";
const STATE_PATH = "/tmp/task19-qa-state.json";

const stamp = Date.now();
const email = `qa19a-${stamp}@example.com`;
const friendEmail = `qa19b-${stamp}@example.com`;
const password = "qa19-password-1";

const sql = postgres(DB, { max: 1 });

async function waitForResetLink(target: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const list = (await (
      await fetch(`${MAILPIT}/api/v1/messages?limit=50`)
    ).json()) as {
      messages?: { ID: string; To?: { Address?: string }[] }[];
    };
    const hit = list.messages?.find((message) =>
      message.To?.some(
        (to) => to.Address?.toLowerCase() === target.toLowerCase(),
      ),
    );
    if (hit) {
      const detail = (await (
        await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)
      ).json()) as { HTML?: string; Text?: string };
      const body = detail.HTML ?? detail.Text ?? "";
      const match = /http:\/\/localhost:3200\/welcome\/password\?[^"\s]+/.exec(
        body.replaceAll("&amp;", "&"),
      );
      if (match) return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("reset link did not arrive in Mailpit");
}

async function createUser(targetEmail: string): Promise<string> {
  const register = await fetch(`${APP}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: targetEmail }),
  });
  if (!register.ok) throw new Error(`register failed ${register.status}`);

  const link = new URL(await waitForResetLink(targetEmail));
  const token = link.searchParams.get("token");
  const setPassword = await fetch(`${APP}/api/auth/set-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, email: targetEmail, password }),
  });
  if (!setPassword.ok) {
    throw new Error(
      `set-password failed ${setPassword.status} ${await setPassword.text()}`,
    );
  }

  const [row] = await sql<Array<{ id: string }>>`
    select id from "user" where email = ${targetEmail}
  `;
  if (!row) throw new Error("registered user row missing");
  return row.id;
}

async function main() {
  await sql`truncate table events cascade`;
  await sql`delete from "user" where email like 'qa19%@example.com'`;

  const organizerUserId = await createUser(email);
  const friendUserId = await createUser(friendEmail);

  const [event] = await sql<Array<{ id: string }>>`
    insert into events (name, organizer_user_id, currency, status)
    values ('QA Close 19', ${organizerUserId}, 'EUR', 'open')
    returning id
  `;
  const eventId = event.id;

  const [organizerMember] = await sql<Array<{ id: string }>>`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at)
    values (${eventId}, ${organizerUserId}, ${email}, 'Quinn Organizer', 'organizer', 'active', now())
    returning id
  `;
  const [friendMember] = await sql<Array<{ id: string }>>`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at)
    values (${eventId}, ${friendUserId}, ${friendEmail}, 'Fran Friend', 'member', 'active', now())
    returning id
  `;
  await sql`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status)
    values (${eventId}, null, 'qa19c-pending@example.com', 'Pat Pending', 'member', 'pending')
  `;

  const [expense] = await sql<Array<{ id: string }>>`
    insert into expenses (event_id, created_by, paid_by_member_id, total_minor, currency, spent_on, description, split_mode, status)
    values (${eventId}, ${organizerUserId}, ${organizerMember.id}, 30000, 'EUR', '2026-11-01', 'Dinner', 'equal', 'open')
    returning id
  `;
  for (const memberId of [organizerMember.id, friendMember.id]) {
    await sql`
      insert into expense_participants (expense_id, member_id, personal_minor)
      values (${expense.id}, ${memberId}, 0)
    `;
  }

  const state = {
    email,
    password,
    friendEmail,
    friendPassword: password,
    eventId,
    expenseId: expense.id,
  };
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  console.log(JSON.stringify(state));
  await sql.end();
}

await main();
