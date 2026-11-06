import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { computeBalances, settle } from "../src/domain/settlement";
import { computeShares } from "../src/domain/split";

const APP = "http://localhost:3200";
const MAILPIT = "http://localhost:8025";
const DB = "postgres://kittie:kittie@localhost:5433/kittie_r18_qa";
const STATE_PATH = "/tmp/task18-qa-state.json";

const email = `qa18-${Date.now()}@example.com`;
const secondEmail = `qa18b-${Date.now()}@example.com`;
const thirdEmail = `qa18c-${Date.now()}@example.com`;
const password = "qa18-password-1";

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
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("reset link did not arrive in Mailpit");
}

interface ParticipantSeed {
  memberId: string;
  personalMinor?: number;
  splitBp?: number;
}

interface ExpenseSeed {
  paidBy: string;
  totalMinor: number;
  splitMode: "equal" | "percentage";
  participants: ParticipantSeed[];
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
  await sql`delete from "user" where email like 'qa18-%@example.com'`;

  const userId = await createUser(email);

  async function createEvent(input: {
    name: string;
    updatedAt: string;
    status: "open" | "closed";
  }): Promise<string> {
    const [row] = await sql<Array<{ id: string }>>`
      insert into events (name, organizer_user_id, currency, status, updated_at, closed_at)
      values (
        ${input.name}, ${userId}, 'EUR', ${input.status},
        ${input.updatedAt}::timestamptz,
        ${input.status === "closed" ? sql`now()` : null}
      )
      returning id
    `;
    return row.id;
  }

  async function createMember(input: {
    eventId: string;
    userId: string | null;
    email: string;
    name: string;
    role: "organizer" | "member";
    status?: "active" | "pending";
    createdAt: string;
  }): Promise<string> {
    const [row] = await sql<Array<{ id: string }>>`
      insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at, created_at)
      values (
        ${input.eventId}, ${input.userId}, ${input.email}, ${input.name},
        ${input.role}, ${input.status ?? "active"}, now(), ${input.createdAt}::timestamptz
      )
      returning id
    `;
    return row.id;
  }

  async function createExpense(input: {
    eventId: string;
    paidByMemberId: string;
    totalMinor: number;
    splitMode: "equal" | "percentage";
    spentOn: string;
    status?: "open" | "voided";
    participants: ParticipantSeed[];
  }): Promise<string> {
    const [row] = await sql<Array<{ id: string }>>`
      insert into expenses (event_id, created_by, paid_by_member_id, total_minor, currency, spent_on, split_mode, status)
      values (
        ${input.eventId}, ${userId}, ${input.paidByMemberId}, ${input.totalMinor},
        'EUR', ${input.spentOn}, ${input.splitMode}, ${input.status ?? "open"}
      )
      returning id
    `;
    for (const participant of input.participants) {
      await sql`
        insert into expense_participants (expense_id, member_id, personal_minor, split_bp)
        values (
          ${row.id}, ${participant.memberId},
          ${participant.personalMinor ?? 0}, ${participant.splitBp ?? null}
        )
      `;
    }
    return row.id;
  }

  const lisbon = await createEvent({
    name: "Lisbon 2026",
    updatedAt: new Date().toISOString(),
    status: "open",
  });
  const ana = await createMember({
    eventId: lisbon,
    userId,
    email,
    name: "Ana",
    role: "organizer",
    createdAt: "2026-01-01T10:00:00Z",
  });
  const bruno = await createMember({
    eventId: lisbon,
    userId: null,
    email: "bruno@example.com",
    name: "Bruno",
    role: "member",
    createdAt: "2026-01-01T10:00:01Z",
  });
  const carla = await createMember({
    eventId: lisbon,
    userId: null,
    email: "carla@example.com",
    name: "Carla",
    role: "member",
    createdAt: "2026-01-01T10:00:02Z",
  });
  const lisbonExpenses: ExpenseSeed[] = [
    {
      paidBy: ana,
      totalMinor: 30000,
      splitMode: "equal" as const,
      participants: [
        { memberId: ana, personalMinor: 5000 },
        { memberId: bruno },
        { memberId: carla },
      ],
    },
    {
      paidBy: bruno,
      totalMinor: 10000,
      splitMode: "percentage" as const,
      participants: [
        { memberId: ana, splitBp: 5000 },
        { memberId: bruno, splitBp: 3000 },
        { memberId: carla, splitBp: 2000 },
      ],
    },
  ];
  for (const expense of lisbonExpenses) {
    await createExpense({
      eventId: lisbon,
      paidByMemberId: expense.paidBy,
      totalMinor: expense.totalMinor,
      splitMode: expense.splitMode,
      spentOn: "2026-02-01",
      participants: expense.participants,
    });
  }

  const porto = await createEvent({
    name: "Porto weekend",
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    status: "open",
  });
  const portoAna = await createMember({
    eventId: porto,
    userId,
    email,
    name: "Ana",
    role: "organizer",
    createdAt: "2026-01-02T10:00:00Z",
  });
  const portoBruno = await createMember({
    eventId: porto,
    userId: null,
    email: "bruno@example.com",
    name: "Bruno",
    role: "member",
    createdAt: "2026-01-02T10:00:01Z",
  });
  await createExpense({
    eventId: porto,
    paidByMemberId: portoAna,
    totalMinor: 2000,
    splitMode: "equal",
    spentOn: "2026-02-02",
    participants: [{ memberId: portoAna }, { memberId: portoBruno }],
  });

  const dolomites = await createEvent({
    name: "Dolomites 2025",
    updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    status: "closed",
  });
  const dolomitesAna = await createMember({
    eventId: dolomites,
    userId,
    email,
    name: "Ana",
    role: "organizer",
    createdAt: "2025-12-01T10:00:00Z",
  });
  const dolomitesBruno = await createMember({
    eventId: dolomites,
    userId: null,
    email: "bruno@example.com",
    name: "Bruno",
    role: "member",
    createdAt: "2025-12-01T10:00:01Z",
  });
  await createExpense({
    eventId: dolomites,
    paidByMemberId: dolomitesAna,
    totalMinor: 5000,
    splitMode: "equal",
    spentOn: "2025-12-02",
    participants: [{ memberId: dolomitesAna }, { memberId: dolomitesBruno }],
  });
  const frozenMembers = [
    {
      memberId: dolomitesAna,
      paidMinor: 5000,
      shareMinor: 2500,
      netMinor: 2500,
    },
    {
      memberId: dolomitesBruno,
      paidMinor: 0,
      shareMinor: 2500,
      netMinor: -2500,
    },
  ];
  const frozenTransfers = [
    {
      fromMemberId: dolomitesBruno,
      toMemberId: dolomitesAna,
      amountMinor: 2500,
    },
  ];
  await sql`
    insert into event_settlements (event_id, version, total_spent_minor, balances_json, transfers_json, closed_at, closed_by)
    values (
      ${dolomites}, 1, 5000,
      ${JSON.stringify({
        version: 1,
        totalSpentMinor: 5000,
        totalOwedMinor: 2500,
        members: frozenMembers,
        transfers: frozenTransfers,
      })}::jsonb,
      ${JSON.stringify(frozenTransfers)}::jsonb,
      now(), ${userId}
    )
  `;
  await createExpense({
    eventId: dolomites,
    paidByMemberId: dolomitesBruno,
    totalMinor: 77777,
    splitMode: "equal",
    spentOn: "2026-03-01",
    participants: [{ memberId: dolomitesAna }, { memberId: dolomitesBruno }],
  });

  const foreign = await createEvent({
    name: "Other group",
    updatedAt: new Date().toISOString(),
    status: "open",
  });
  await sql`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at)
    values (${foreign}, ${"eeeeeeee-0000-4000-8000-00000000000e"}, 'zoe@example.com', 'Zoe', 'organizer', 'active', now())
  `;

  const expectedSettlement = computeBalances(
    lisbonExpenses.map((expense) => ({
      paidByMemberId: expense.paidBy,
      totalMinor: expense.totalMinor,
      shares: computeShares({
        totalMinor: expense.totalMinor,
        mode: expense.splitMode,
        participants: expense.participants.map((participant) => ({
          memberId: participant.memberId,
          personalMinor: participant.personalMinor ?? 0,
          splitBp: participant.splitBp,
        })),
      }).shares.map((share) => ({
        memberId: share.memberId,
        shareMinor: share.shareMinor,
      })),
      voided: false,
    })),
  );
  const expectedTransfers = settle(expectedSettlement.balances, [
    ana,
    bruno,
    carla,
  ]);

  const secondUserId = await createUser(secondEmail);
  await createUser(thirdEmail);
  const solo = await createEvent({
    name: "Solo trip",
    updatedAt: new Date().toISOString(),
    status: "open",
  });
  await sql`
    update events set organizer_user_id = ${secondUserId} where id = ${solo}
  `;
  await sql`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at)
    values (${solo}, ${secondUserId}, ${secondEmail}, 'Solo', 'organizer', 'active', now())
  `;

  const state = {
    email,
    password,
    secondEmail,
    secondPassword: password,
    thirdEmail,
    thirdPassword: password,
    secondUserId,
    events: { lisbon, porto, dolomites, foreign, solo },
    expected: {
      lisbonTotalMinor: expectedSettlement.totalSpentMinor,
      lisbonTransfers: expectedTransfers,
      portoTotalMinor: 2000,
    },
  };
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  console.log(JSON.stringify(state));
  await sql.end();
}

await main();
