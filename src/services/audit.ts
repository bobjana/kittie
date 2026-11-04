import { db } from "@/db/client";
import { auditLog } from "@/db/schema";

export interface AuditEntry {
  eventId: string;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Writes one audit row; pass a transaction executor to join one in-flight. */
export async function writeAudit(
  entry: AuditEntry,
  executor: TransactionExecutor | typeof db = db,
): Promise<void> {
  await executor.insert(auditLog).values({
    eventId: entry.eventId,
    actorUserId: entry.actorUserId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    beforeJson: entry.before ?? null,
    afterJson: entry.after ?? null,
  });
}
