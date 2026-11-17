import { prisma } from "@/services/prisma";
import { recordActivity, dispatchActivity, type ActivityInput } from "@/services/outbox";

/**
 * Writes an audit entry and sets the notifications for it in motion.
 *
 * The entry is written first and is what the notification work is driven from
 * (see services/outbox.ts), so a crash after this point can't lose the notification:
 * the worker's relay finds the unprocessed entry. Code that needs the entry to
 * commit together with its own change should call recordActivity() inside its
 * transaction and dispatchActivity() after it instead.
 *
 * Throws only if the audit entry itself can't be written.
 */
export async function logActivity(action: string, options: ActivityInput = {}) {
  const id = await recordActivity(prisma, action, options);
  await dispatchActivity(id);
}
