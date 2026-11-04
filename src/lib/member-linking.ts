import { and, eq } from "drizzle-orm";
import { user as authUser } from "@/db/auth-schema";
import { db } from "@/db/client";
import { eventMembers } from "@/db/schema";

export async function linkPendingMembersByEmail(
  emailNormalized: string,
): Promise<void> {
  const rows = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, emailNormalized))
    .limit(1);
  const userId = rows[0]?.id;
  if (!userId) {
    return;
  }

  await db
    .update(eventMembers)
    .set({ userId, status: "active", joinedAt: new Date() })
    .where(
      and(
        eq(eventMembers.emailNormalized, emailNormalized),
        eq(eventMembers.status, "pending"),
      ),
    );
}
