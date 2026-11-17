import { prisma, Prisma } from "@/services/prisma";
import { publishNotificationsCreated } from "@/services/realtime";

type ActivityOptions = {
  actorId?: number | null;
  resourceType?: string;
  resourceId?: number;
  changes?: Record<string, unknown>;
  /** The outbox event these notifications belong to (makes delivery idempotent). */
  activityLogId?: number;
};

type Recipient = { userId: number; message: string };

type Db = Prisma.TransactionClient | typeof prisma;

async function staffIds(db: Db, excludeId?: number | null): Promise<number[]> {
  const users = await db.user.findMany({
    where: { role: { in: ["ADMIN", "ASSET_MANAGER"] }, status: "ACTIVE" },
    select: { id: true },
  });
  return users.map((u) => u.id).filter((id) => id !== excludeId);
}

async function assetLabel(db: Db, assetId: number | null | undefined): Promise<string> {
  if (!assetId) return "An asset";
  const asset = await db.asset.findUnique({
    where: { id: assetId },
    select: { assetTag: true, name: true },
  });
  return asset ? `${asset.assetTag} — ${asset.name}` : "An asset";
}

/**
 * Creates the notifications for one activity event using `db` (a transaction
 * client, so the work holds ONE connection and commits together with whatever
 * else is in that transaction) and returns the ids of the people notified.
 * It does not tell open browser tabs: call publishNotificationsCreated() with
 * the result AFTER the transaction has committed, or the tabs would reload
 * before the rows are visible.
 */
export async function createNotificationsFor(
  db: Db,
  action: string,
  opts: ActivityOptions
): Promise<number[]> {
  const recipients: Recipient[] = [];
  const changes = opts.changes ?? {};
  const rid = opts.resourceId;

  // `skipActor`: don't tell people about something they just did themselves.
  const add = (
    ids: (number | null | undefined)[],
    message: string,
    skipActor = false
  ) => {
    for (const id of ids) {
      if (!id) continue;
      if (skipActor && id === opts.actorId) continue;
      recipients.push({ userId: id, message });
    }
  };

  switch (action) {
    case "asset_allocated": {
      const holderId = changes.holderId as number | null | undefined;
      add([holderId], `${await assetLabel(db, rid)} has been assigned to you.`);
      break;
    }

    // A transfer is waiting for a decision: tell the people who can decide it,
    // and the person who currently holds the asset.
    case "transfer_requested": {
      const tr = rid ? await db.transferRequest.findUnique({ where: { id: rid } }) : null;
      // Requests made by managers are approved on the spot and reported as
      // "transfer_completed" instead, so there is nothing to approve here.
      if (!tr || tr.status !== "PENDING") break;

      const label = await assetLabel(db, tr.assetId);
      const holder = tr.fromHolderId
        ? await db.user.findUnique({ where: { id: tr.fromHolderId }, select: { departmentId: true } })
        : null;
      const deptHeads = holder?.departmentId
        ? await db.user.findMany({
            where: { role: "DEPARTMENT_HEAD", status: "ACTIVE", departmentId: holder.departmentId },
            select: { id: true },
          })
        : [];

      const approvalMsg = `A transfer request for ${label} is waiting for your approval.`;
      add(await staffIds(db), approvalMsg, true);
      add(deptHeads.map((u) => u.id), approvalMsg, true);
      add([tr.fromHolderId], `Someone has requested a transfer of ${label}, which you currently hold.`, true);
      break;
    }

    // Manager-initiated transfers: done immediately.
    case "transfer_completed": {
      const tr = rid ? await db.transferRequest.findUnique({ where: { id: rid } }) : null;
      if (!tr) break;
      const label = await assetLabel(db, tr.assetId);
      add([tr.toHolderId], `${label} has been transferred to you.`, true);
      add([tr.fromHolderId], `${label} was transferred away from you.`, true);
      break;
    }

    case "transfer_approved": {
      const tr = rid ? await db.transferRequest.findUnique({ where: { id: rid } }) : null;
      if (!tr) break;
      const label = await assetLabel(db, tr.assetId);
      // Order matters: when the requester is also the new holder they get one
      // notification (the first), not two.
      add([tr.requestedBy], `Your transfer request for ${label} was approved.`, true);
      add([tr.toHolderId], `${label} has been transferred to you.`, true);
      add([tr.fromHolderId], `${label} was transferred away from you.`, true);
      break;
    }

    case "transfer_rejected":
    case "transfer_cancelled": {
      const tr = rid ? await db.transferRequest.findUnique({ where: { id: rid } }) : null;
      if (!tr) break;
      const verb = action.replace("transfer_", "");
      add([tr.requestedBy], `Your transfer request for ${await assetLabel(db, tr.assetId)} was ${verb}.`, true);
      break;
    }

    case "maintenance_raised": {
      const ids = await staffIds(db, opts.actorId);
      add(ids, "A new maintenance request was raised.");
      break;
    }
    case "maintenance_approved":
    case "maintenance_rejected":
    case "maintenance_in_progress":
    case "maintenance_resolved": {
      const mr = rid ? await db.maintenanceRequest.findUnique({ where: { id: rid } }) : null;
      const messages: Record<string, string> = {
        maintenance_approved: "Your maintenance request was approved.",
        maintenance_rejected: "Your maintenance request was rejected.",
        maintenance_in_progress: "Work has started on your maintenance request.",
        maintenance_resolved: "Your maintenance request was resolved.",
      };
      if (mr) add([mr.requesterId], messages[action]);
      break;
    }
    case "maintenance_technician_assigned": {
      const mr = rid ? await db.maintenanceRequest.findUnique({ where: { id: rid } }) : null;
      if (mr) add([mr.technicianId], "You were assigned a maintenance task.");
      break;
    }

    case "booking_confirmed":
      add([opts.actorId], "Your resource booking is confirmed.");
      break;

    // Sent by the scheduled booking job, shortly before a booking starts.
    case "booking_reminder": {
      const booking = rid
        ? await db.resourceBooking.findUnique({
            where: { id: rid },
            include: { resource: { select: { name: true } } },
          })
        : null;
      if (booking) add([booking.bookerId], `Your booking of ${booking.resource.name} starts in about 15 minutes.`);
      break;
    }

    // Sent by the scheduled overdue job: the holder, and the people who chase it up.
    case "allocation_overdue": {
      const allocation = rid
        ? await db.allocation.findUnique({
            where: { id: rid },
            include: { holder: { select: { firstName: true, lastName: true } } },
          })
        : null;
      if (!allocation) break;
      const label = await assetLabel(db, allocation.assetId);
      const due = allocation.expectedReturnDate
        ? allocation.expectedReturnDate.toISOString().slice(0, 10)
        : "its due date";
      const holder = allocation.holder
        ? `${allocation.holder.firstName} ${allocation.holder.lastName}`
        : "a department";
      add([allocation.holderId], `${label} was due back on ${due} and is now overdue. Please return it.`);
      add(await staffIds(db), `${label} is overdue (held by ${holder}, due ${due}).`);
      break;
    }

    // Only matters when someone else (a manager) cancelled it.
    case "booking_cancelled": {
      const booking = rid ? await db.resourceBooking.findUnique({ where: { id: rid } }) : null;
      if (booking) add([booking.bookerId], "Your resource booking was cancelled.", true);
      break;
    }

    // Only matters when someone else (a manager) moved it.
    case "booking_rescheduled": {
      const booking = rid
        ? await db.resourceBooking.findUnique({
            where: { id: rid },
            include: { resource: { select: { name: true } } },
          })
        : null;
      if (booking) {
        const when = booking.startTime.toISOString().slice(0, 16).replace("T", " ");
        add([booking.bookerId], `Your booking of ${booking.resource.name} was moved to ${when} UTC.`, true);
      }
      break;
    }

    // An admin put the user on an audit cycle.
    case "audit_assigned": {
      add([changes.auditorId as number | undefined], `You were assigned as an auditor for "${String(changes.cycleName)}".`);
      break;
    }

    case "audit_finding_recorded": {
      if (changes.status && changes.status !== "VERIFIED") {
        add(await staffIds(db, opts.actorId), "An audit discrepancy was flagged.");
      }
      break;
    }

    case "role_changed": {
      add([rid], `Your role was changed to ${String(changes.to)}.`);
      break;
    }

    default:
      return [];
  }

  // One notification per person per event, even if they fall into several groups.
  const seen = new Set<number>();
  const unique = recipients.filter((r) => {
    if (seen.has(r.userId)) return false;
    seen.add(r.userId);
    return true;
  });

  if (unique.length === 0) return [];

  await db.notification.createMany({
    data: unique.map((r) => ({
      userId: r.userId,
      type: action,
      message: r.message,
      relatedResourceType: opts.resourceType ?? null,
      relatedResourceId: opts.resourceId ?? null,
      activityLogId: opts.activityLogId ?? null,
    })),
    // With an activityLogId, (event, user, type) is unique: running the same
    // event twice must not notify anyone twice.
    skipDuplicates: true,
  });

  return unique.map((r) => r.userId);
}

/**
 * Creates the notifications for one event and tells open browser tabs.
 * Used for jobs that have no outbox row (queued before the outbox existed).
 */
export async function notifyForActivity(action: string, opts: ActivityOptions) {
  const userIds = await createNotificationsFor(prisma, action, opts);
  // Never throws: the notifications are already saved.
  await publishNotificationsCreated(userIds);
}
