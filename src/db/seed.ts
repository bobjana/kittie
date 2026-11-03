import { client, db } from "./client";
import { eventMembers, events, expenseParticipants, expenses } from "./schema";

const eventId = "00000000-0000-4000-8000-000000000001";
const organizerMemberId = "00000000-0000-4000-8000-000000000011";
const friendMemberId = "00000000-0000-4000-8000-000000000012";
const expenseId = "00000000-0000-4000-8000-000000000021";
const seedUserId = "11111111-1111-4111-8111-111111111111";

try {
  await db
    .insert(events)
    .values({
      id: eventId,
      name: "Lisbon 2026",
      currency: "EUR",
      status: "open",
      organizerUserId: seedUserId,
    })
    .onConflictDoNothing();

  await db
    .insert(eventMembers)
    .values([
      {
        id: organizerMemberId,
        eventId,
        userId: seedUserId,
        emailNormalized: "organizer@example.com",
        displayName: "Organizer",
        role: "organizer",
        status: "active",
      },
      {
        id: friendMemberId,
        eventId,
        userId: null,
        emailNormalized: "friend@example.com",
        displayName: "Friend",
        role: "member",
        status: "active",
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(expenses)
    .values({
      id: expenseId,
      eventId,
      createdBy: seedUserId,
      paidByMemberId: organizerMemberId,
      totalMinor: 3000,
      currency: "EUR",
      spentOn: "2026-11-03",
      description: "Welcome dinner",
      splitMode: "equal",
      status: "open",
    })
    .onConflictDoNothing();

  await db
    .insert(expenseParticipants)
    .values([
      {
        id: "00000000-0000-4000-8000-000000000031",
        expenseId,
        memberId: organizerMemberId,
      },
      {
        id: "00000000-0000-4000-8000-000000000032",
        expenseId,
        memberId: friendMemberId,
      },
    ])
    .onConflictDoNothing();

  const counts = await client`
    select
      (select count(*)::int from events) as events,
      (select count(*)::int from event_members) as event_members,
      (select count(*)::int from expenses) as expenses,
      (select count(*)::int from expense_participants) as expense_participants
  `;
  console.log("Seed complete. Row counts:", counts[0]);
} finally {
  await client.end();
}
