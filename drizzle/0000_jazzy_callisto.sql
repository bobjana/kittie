CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before_json" jsonb,
	"after_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"email_normalized" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "event_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid,
	"email_normalized" text NOT NULL,
	"display_name" text,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" uuid,
	"invited_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_members_role_check" CHECK ("event_members"."role" in ('organizer', 'member')),
	CONSTRAINT "event_members_status_check" CHECK ("event_members"."status" in ('pending', 'active', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "event_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"total_spent_minor" bigint NOT NULL,
	"balances_json" jsonb,
	"transfers_json" jsonb,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "event_settlements_total_spent_minor_check" CHECK ("event_settlements"."total_spent_minor" >= 0 and "event_settlements"."total_spent_minor" <= 10000000000000)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"organizer_user_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"reopened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_status_check" CHECK ("events"."status" in ('open', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "expense_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"personal_minor" bigint DEFAULT 0 NOT NULL,
	"split_bp" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_participants_personal_minor_check" CHECK ("expense_participants"."personal_minor" >= 0 and "expense_participants"."personal_minor" <= 10000000000000),
	CONSTRAINT "expense_participants_split_bp_check" CHECK ("expense_participants"."split_bp" is null or ("expense_participants"."split_bp" >= 0 and "expense_participants"."split_bp" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"created_by" uuid,
	"paid_by_member_id" uuid,
	"total_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"spent_on" date NOT NULL,
	"description" text,
	"split_mode" text DEFAULT 'equal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_total_minor_check" CHECK ("expenses"."total_minor" > 0 and "expenses"."total_minor" <= 10000000000000),
	CONSTRAINT "expenses_split_mode_check" CHECK ("expenses"."split_mode" in ('equal', 'percentage')),
	CONSTRAINT "expenses_status_check" CHECK ("expenses"."status" in ('open', 'voided'))
);
--> statement-breakpoint
CREATE TABLE "notification_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text DEFAULT 'close_tally' NOT NULL,
	"event_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"recipient_member_id" uuid NOT NULL,
	"recipient_email" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_jobs_type_check" CHECK ("notification_jobs"."type" in ('close_tally')),
	CONSTRAINT "notification_jobs_status_check" CHECK ("notification_jobs"."status" in ('queued', 'running', 'sent', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "ocr_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"provider" text,
	"model" text,
	"result_json" jsonb,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocr_jobs_receipt_id_unique" UNIQUE("receipt_id"),
	CONSTRAINT "ocr_jobs_status_check" CHECK ("ocr_jobs"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"expense_id" uuid,
	"uploaded_by" uuid,
	"object_key" text NOT NULL,
	"mime" text,
	"size_bytes" bigint,
	"width" integer,
	"height" integer,
	"sha256" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "receipts_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "request_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_invites" ADD CONSTRAINT "event_invites_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_invites" ADD CONSTRAINT "event_invites_member_id_event_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."event_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_members" ADD CONSTRAINT "event_members_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_settlements" ADD CONSTRAINT "event_settlements_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_participants" ADD CONSTRAINT "expense_participants_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_participants" ADD CONSTRAINT "expense_participants_member_id_event_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."event_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_by_member_id_event_members_id_fk" FOREIGN KEY ("paid_by_member_id") REFERENCES "public"."event_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_settlement_id_event_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."event_settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_recipient_member_id_event_members_id_fk" FOREIGN KEY ("recipient_member_id") REFERENCES "public"."event_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_event_id_idx" ON "audit_log" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_invites_event_id_idx" ON "event_invites" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_invites_member_id_idx" ON "event_invites" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_members_event_email_active_idx" ON "event_members" USING btree ("event_id","email_normalized") WHERE "event_members"."status" <> 'removed';--> statement-breakpoint
CREATE UNIQUE INDEX "event_members_event_user_active_idx" ON "event_members" USING btree ("event_id","user_id") WHERE "event_members"."user_id" is not null and "event_members"."status" <> 'removed';--> statement-breakpoint
CREATE INDEX "event_members_event_id_idx" ON "event_members" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_members_user_id_idx" ON "event_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_settlements_event_active_idx" ON "event_settlements" USING btree ("event_id") WHERE "event_settlements"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "event_settlements_event_id_idx" ON "event_settlements" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "events_organizer_user_id_idx" ON "events" USING btree ("organizer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_participants_expense_member_idx" ON "expense_participants" USING btree ("expense_id","member_id");--> statement-breakpoint
CREATE INDEX "expense_participants_member_id_idx" ON "expense_participants" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "expenses_event_id_idx" ON "expenses" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "expenses_paid_by_member_id_idx" ON "expenses" USING btree ("paid_by_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_jobs_settlement_recipient_idx" ON "notification_jobs" USING btree ("settlement_id","recipient_member_id");--> statement-breakpoint
CREATE INDEX "notification_jobs_event_id_idx" ON "notification_jobs" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "notification_jobs_recipient_member_id_idx" ON "notification_jobs" USING btree ("recipient_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_expense_id_idx" ON "receipts" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "receipts_event_id_idx" ON "receipts" USING btree ("event_id");