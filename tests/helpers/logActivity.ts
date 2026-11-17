import { prisma } from "@/services/prisma";
import { recordActivity, dispatchActivity, type ActivityInput } from "@/services/outbox";

/**
 * Test helper: writes an audit entry and delivers its notifications in one call.
 *
 * The app itself calls recordActivity() inside the transaction that makes the change
 * and dispatchActivity() after it commits; tests that only need "an entry exists and
 * was delivered" use this shortcut instead.
 */
export async function logActivity(action: string, options: ActivityInput = {}) {
  const id = await recordActivity(prisma, action, options);
  await dispatchActivity(id);
}
