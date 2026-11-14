import { prisma } from "@/lib/prisma";

type ActivityOptions = {
  actorId?: number | null;
  resourceType?: string;
  resourceId?: number;
  changes?: Record<string, unknown>;
};

type Recipient = { userId: number; message: string };

async function staffIds(excludeId?: number | null): Promise<number[]> {
  const users = await prisma.user.findMany({
    where: { role: { in: ["ADMIN", "ASSET_MANAGER"] }, status: "ACTIVE" },
    select: { id: true },
  });
  return users.map((u) => u.id).filter((id) => id !== excludeId);
}

async function assetLabel(assetId: number | null | undefined): Promise<string> {
  if (!assetId) return "An asset";
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { assetTag: true, name: true },
  });
  return asset ? `${asset.assetTag} — ${asset.name}` : "An asset";
}

/**
 * Turns an activity event into notifications for the people it affects.
 * Called from logActivity(); never throws to the caller.
 */
export async function notifyForActivity(action: string, opts: ActivityOptions) {
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
      add([holderId], `${await assetLabel(rid)} has been assigned to you.`);
      break;
    }

    // A transfer is waiting for a decision: tell the people who can decide it,
    // and the person who currently holds the asset.
    case "transfer_requested": {
      const tr = rid ? await prisma.transferRequest.findUnique({ where: { id: rid } }) : null;
      // Requests made by managers are approved on the spot and reported as
      // "transfer_completed" instead, so there is nothing to approve here.
      if (!tr || tr.status !== "PENDING") break;

      const label = await assetLabel(tr.assetId);
      const holder = tr.fromHolderId
        ? await prisma.user.findUnique({ where: { id: tr.fromHolderId }, select: { departmentId: true } })
        : null;
      const deptHeads = holder?.departmentId
        ? await prisma.user.findMany({
            where: { role: "DEPARTMENT_HEAD", status: "ACTIVE", departmentId: holder.departmentId },
            select: { id: true },
          })
        : [];

      const approvalMsg = `A transfer request for ${label} is waiting for your approval.`;
      add(await staffIds(), approvalMsg, true);
      add(deptHeads.map((u) => u.id), approvalMsg, true);
      add([tr.fromHolderId], `Someone has requested a transfer of ${label}, which you currently hold.`, true);
      break;
    }

    // Manager-initiated transfers: done immediately.
    case "transfer_completed": {
      const tr = rid ? await prisma.transferRequest.findUnique({ where: { id: rid } }) : null;
      if (!tr) break;
      const label = await assetLabel(tr.assetId);
      add([tr.toHolderId], `${label} has been transferred to you.`, true);
      add([tr.fromHolderId], `${label} was transferred away from you.`, true);
      break;
    }

    case "transfer_approved": {
      const tr = rid ? await prisma.transferRequest.findUnique({ where: { id: rid } }) : null;
      if (!tr) break;
      const label = await assetLabel(tr.assetId);
      // Order matters: when the requester is also the new holder they get one
      // notification (the first), not two.
      add([tr.requestedBy], `Your transfer request for ${label} was approved.`, true);
      add([tr.toHolderId], `${label} has been transferred to you.`, true);
      add([tr.fromHolderId], `${label} was transferred away from you.`, true);
      break;
    }

    case "transfer_rejected":
    case "transfer_cancelled": {
      const tr = rid ? await prisma.transferRequest.findUnique({ where: { id: rid } }) : null;
      if (!tr) break;
      const verb = action.replace("transfer_", "");
      add([tr.requestedBy], `Your transfer request for ${await assetLabel(tr.assetId)} was ${verb}.`, true);
      break;
    }

    case "maintenance_raised": {
      const ids = await staffIds(opts.actorId);
      add(ids, "A new maintenance request was raised.");
      break;
    }
    case "maintenance_approved":
    case "maintenance_rejected":
    case "maintenance_in_progress":
    case "maintenance_resolved": {
      const mr = rid ? await prisma.maintenanceRequest.findUnique({ where: { id: rid } }) : null;
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
      const mr = rid ? await prisma.maintenanceRequest.findUnique({ where: { id: rid } }) : null;
      if (mr) add([mr.technicianId], "You were assigned a maintenance task.");
      break;
    }

    case "booking_confirmed":
      add([opts.actorId], "Your resource booking is confirmed.");
      break;

    // Only matters when someone else (a manager) cancelled it.
    case "booking_cancelled": {
      const booking = rid ? await prisma.resourceBooking.findUnique({ where: { id: rid } }) : null;
      if (booking) add([booking.bookerId], "Your resource booking was cancelled.", true);
      break;
    }

    case "audit_finding_recorded": {
      if (changes.status && changes.status !== "VERIFIED") {
        add(await staffIds(opts.actorId), "An audit discrepancy was flagged.");
      }
      break;
    }

    case "role_changed": {
      add([rid], `Your role was changed to ${String(changes.to)}.`);
      break;
    }

    default:
      return;
  }

  // One notification per person per event, even if they fall into several groups.
  const seen = new Set<number>();
  const unique = recipients.filter((r) => {
    if (seen.has(r.userId)) return false;
    seen.add(r.userId);
    return true;
  });

  if (unique.length === 0) return;

  await prisma.notification.createMany({
    data: unique.map((r) => ({
      userId: r.userId,
      type: action,
      message: r.message,
      relatedResourceType: opts.resourceType ?? null,
      relatedResourceId: opts.resourceId ?? null,
    })),
  });
}