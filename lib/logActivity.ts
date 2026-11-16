import { prisma } from "@/lib/prisma";
import { notifyForActivity } from "@/lib/notifications";
import { enqueueNotification } from "@/lib/queue";

type LogActivityOptions = {
  actorId?: number | null;
  resourceType?: string;
  resourceId?: number;
  changes?: Record<string, unknown>;
};

export async function logActivity(action: string, options: LogActivityOptions = {}) {
  // The audit trail is written straight away: it is cheap and must never be lost.
  await prisma.activityLog.create({
    data: {
      actorId: options.actorId ?? null,
      action,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      changes: options.changes ? JSON.stringify(options.changes) : null,
    },
  });

  // Working out who to notify, and writing those notifications, is handed to the
  // worker process so the request that triggered it doesn't wait for it.
  // If it can't be queued (inline mode, or Redis is down) we do it here instead,
  // so notifications are delayed at worst, never lost.
  // Notifications must never break the action that triggered them.
  try {
    const queued = await enqueueNotification(action, options);
    if (!queued) await notifyForActivity(action, options);
  } catch (err) {
    console.error("notification failed for", action, err);
  }
}