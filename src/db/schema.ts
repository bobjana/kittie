import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// User-id columns have no foreign key: the Better Auth user table is added in a later todo (row 7).
const MAX_MINOR = sql.raw("10000000000000");

export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("EUR"),
    startsOn: date("starts_on", { mode: "string" }),
    endsOn: date("ends_on", { mode: "string" }),
    organizerUserId: uuid("organizer_user_id").notNull(),
    status: text("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    closedBy: uuid("closed_by"),
    reopenedAt: timestamp("reopened_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("events_status_check", sql`${table.status} in ('open', 'closed')`),
    index("events_organizer_user_id_idx").on(table.organizerUserId),
  ],
);

export const eventMembers = pgTable(
  "event_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    emailNormalized: text("email_normalized").notNull(),
    displayName: text("display_name"),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("pending"),
    invitedBy: uuid("invited_by"),
    invitedAt: timestamp("invited_at", { withTimezone: true, mode: "date" }),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "event_members_role_check",
      sql`${table.role} in ('organizer', 'member')`,
    ),
    check(
      "event_members_status_check",
      sql`${table.status} in ('pending', 'active', 'removed')`,
    ),
    uniqueIndex("event_members_event_email_active_idx")
      .on(table.eventId, table.emailNormalized)
      .where(sql`${table.status} <> 'removed'`),
    uniqueIndex("event_members_event_user_active_idx")
      .on(table.eventId, table.userId)
      .where(sql`${table.userId} is not null and ${table.status} <> 'removed'`),
    index("event_members_event_id_idx").on(table.eventId),
    index("event_members_user_id_idx").on(table.userId),
  ],
);

export const eventInvites = pgTable(
  "event_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => eventMembers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    emailNormalized: text("email_normalized").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("event_invites_event_id_idx").on(table.eventId),
    index("event_invites_member_id_idx").on(table.memberId),
  ],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by"),
    paidByMemberId: uuid("paid_by_member_id").references(
      () => eventMembers.id,
      { onDelete: "set null" },
    ),
    totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("EUR"),
    spentOn: date("spent_on", { mode: "string" }).notNull(),
    description: text("description"),
    splitMode: text("split_mode").notNull().default("equal"),
    status: text("status").notNull().default("open"),
    version: integer("version").notNull().default(1),
    voidedAt: timestamp("voided_at", { withTimezone: true, mode: "date" }),
    voidedBy: uuid("voided_by"),
    voidReason: text("void_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "expenses_total_minor_check",
      sql`${table.totalMinor} > 0 and ${table.totalMinor} <= ${MAX_MINOR}`,
    ),
    check(
      "expenses_split_mode_check",
      sql`${table.splitMode} in ('equal', 'percentage')`,
    ),
    check("expenses_status_check", sql`${table.status} in ('open', 'voided')`),
    index("expenses_event_id_idx").on(table.eventId),
    index("expenses_paid_by_member_id_idx").on(table.paidByMemberId),
  ],
);

export const expenseParticipants = pgTable(
  "expense_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => eventMembers.id, { onDelete: "cascade" }),
    personalMinor: bigint("personal_minor", { mode: "number" })
      .notNull()
      .default(0),
    splitBp: integer("split_bp"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "expense_participants_personal_minor_check",
      sql`${table.personalMinor} >= 0 and ${table.personalMinor} <= ${MAX_MINOR}`,
    ),
    check(
      "expense_participants_split_bp_check",
      sql`${table.splitBp} is null or (${table.splitBp} >= 0 and ${table.splitBp} <= 10000)`,
    ),
    uniqueIndex("expense_participants_expense_member_idx").on(
      table.expenseId,
      table.memberId,
    ),
    index("expense_participants_member_id_idx").on(table.memberId),
  ],
);

export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    expenseId: uuid("expense_id").references(() => expenses.id, {
      onDelete: "set null",
    }),
    uploadedBy: uuid("uploaded_by"),
    objectKey: text("object_key").notNull().unique(),
    mime: text("mime"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    width: integer("width"),
    height: integer("height"),
    sha256: char("sha256", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("receipts_expense_id_idx").on(table.expenseId),
    index("receipts_event_id_idx").on(table.eventId),
  ],
);

export const ocrJobs = pgTable(
  "ocr_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    receiptId: uuid("receipt_id")
      .notNull()
      .unique()
      .references(() => receipts.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    provider: text("provider"),
    model: text("model"),
    resultJson: jsonb("result_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "ocr_jobs_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed')`,
    ),
  ],
);

export const eventSettlements = pgTable(
  "event_settlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    totalSpentMinor: bigint("total_spent_minor", { mode: "number" }).notNull(),
    balancesJson: jsonb("balances_json"),
    transfersJson: jsonb("transfers_json"),
    closedBy: uuid("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    supersededAt: timestamp("superseded_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    check(
      "event_settlements_total_spent_minor_check",
      sql`${table.totalSpentMinor} >= 0 and ${table.totalSpentMinor} <= ${MAX_MINOR}`,
    ),
    uniqueIndex("event_settlements_event_active_idx")
      .on(table.eventId)
      .where(sql`${table.supersededAt} is null`),
    index("event_settlements_event_id_idx").on(table.eventId),
  ],
);

export const notificationJobs = pgTable(
  "notification_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: text("type").notNull().default("close_tally"),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    settlementId: uuid("settlement_id")
      .notNull()
      .references(() => eventSettlements.id, { onDelete: "cascade" }),
    recipientMemberId: uuid("recipient_member_id")
      .notNull()
      .references(() => eventMembers.id, { onDelete: "cascade" }),
    recipientEmail: text("recipient_email").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "notification_jobs_type_check",
      sql`${table.type} in ('close_tally')`,
    ),
    check(
      "notification_jobs_status_check",
      sql`${table.status} in ('queued', 'running', 'sent', 'failed', 'cancelled')`,
    ),
    uniqueIndex("notification_jobs_settlement_recipient_idx").on(
      table.settlementId,
      table.recipientMemberId,
    ),
    index("notification_jobs_event_id_idx").on(table.eventId),
    index("notification_jobs_recipient_member_id_idx").on(
      table.recipientMemberId,
    ),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id"),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    beforeJson: jsonb("before_json"),
    afterJson: jsonb("after_json"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("audit_log_event_id_idx").on(table.eventId)],
);

export const requestThrottle = pgTable("request_throttle", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  count: integer("count").notNull().default(0),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});
