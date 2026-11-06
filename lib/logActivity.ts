import { prisma } from "@/lib/prisma";
import { notifyForActivity } from "@/lib/notifications";

type LogActivityOptions = {
  actorId?: number | null;
  resourceType?: string;
  resourceId?: number;
  changes?: Record<string, unknown>;
};

export async function logActivity(action: string, options: LogActivityOptions = {}) {
  await prisma.activityLog.create({
    data: {
      actorId: options.actorId ?? null,
      action,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      changes: options.changes ? JSON.stringify(options.changes) : null,
    },
  });

  // Notifications must never break the action that triggered them.
  try {
    await notifyForActivity(action, options);
  } catch (err) {
    console.error("notification failed for", action, err);
  }
}
