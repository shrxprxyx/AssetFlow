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
  let queued = false;
  try {
    queued = await enqueueNotification(action, options);
  } catch (err) {
    // The queue itself misbehaved: treat it as "not queued" and do the work here.
    console.error("could not queue notification for", action, err);
  }

  // If it wasn't queued (inline mode, Redis down, or the queue failed) we create
  // the notifications ourselves, so they are delayed at worst, never lost.
  // Notifications must never break the action that triggered them.
  if (!queued) {
    try {
      await notifyForActivity(action, options);
    } catch (err) {
      console.error("notification failed for", action, err);
    }
  }
}