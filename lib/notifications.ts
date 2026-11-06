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

/**
 * Turns an activity event into notifications for the people it affects.
 * Called from logActivity(); never throws to the caller.
 */
export async function notifyForActivity(action: string, opts: ActivityOptions) {
  const recipients: Recipient[] = [];
  const add = (ids: (number | null | undefined)[], message: string) => {
    for (const id of ids) if (id) recipients.push({ userId: id, message });
  };
  const changes = opts.changes ?? {};
  const rid = opts.resourceId;

  switch (action) {
    case "asset_allocated": {
      const holderId = changes.holderId as number | null | undefined;
      const asset = rid ? await prisma.asset.findUnique({ where: { id: rid }, select: { name: true, assetTag: true } }) : null;
      add([holderId], `${asset ? `${asset.assetTag} — ${asset.name}` : "An asset"} has been assigned to you.`);
      break;
    }

    case "transfer_requested": {
      const tr = rid ? await prisma.transferRequest.findUnique({ where: { id: rid } }) : null;
      if (tr) add([tr.toHolderId], "An asset transfer to you has been requested.");
      break;
    }
    case "transfer_completed": {
      const tr = rid ? await prisma.transferRequest.findUnique({ where: { id: rid } }) : null;
      if (tr) add([tr.requestedBy, tr.toHolderId], "Asset transfer completed.");
      break;
    }
    case "transfer_approved":
    case "transfer_rejected":
    case "transfer_cancelled": {
      const tr = rid ? await prisma.transferRequest.findUnique({ where: { id: rid } }) : null;
      const verb = action.replace("transfer_", "");
      if (tr) add([tr.requestedBy], `Your transfer request was ${verb}.`);
      break;
    }

    case "maintenance_raised": {
      const ids = await staffIds(opts.actorId);
      add(ids, "A new maintenance request was raised.");
      break;
    }
    case "maintenance_approved":
    case "maintenance_rejected":
    case "maintenance_resolved": {
      const mr = rid ? await prisma.maintenanceRequest.findUnique({ where: { id: rid } }) : null;
      const msg =
        action === "maintenance_resolved"
          ? "Your maintenance request was resolved."
          : `Your maintenance request was ${action === "maintenance_approved" ? "approved" : "rejected"}.`;
      if (mr) add([mr.requesterId], msg);
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

  if (recipients.length === 0) return;

  await prisma.notification.createMany({
    data: recipients.map((r) => ({
      userId: r.userId,
      type: action,
      message: r.message,
      relatedResourceType: opts.resourceType ?? null,
      relatedResourceId: opts.resourceId ?? null,
    })),
  });
}
