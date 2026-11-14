import { prisma, Prisma } from "./prisma";

type HttpError = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, message: string, field?: string): HttpError => ({
  status,
  body: field ? { error, message, field } : { error, message },
});
const notFound = () => fail(404, "not_found", "Maintenance request not found");

// Assets in these states can't go into (or come back out of) maintenance.
const NOT_MAINTAINABLE: string[] = ["LOST", "RETIRED", "DISPOSED"];

const notMaintainable = (status: string) =>
  fail(
    409,
    "asset_not_maintainable",
    `A ${status.toLowerCase()} asset can't be sent for maintenance`
  );

async function lockAsset(tx: Prisma.TransactionClient, assetId: number) {
  await tx.$queryRaw`SELECT id FROM "Asset" WHERE id = ${assetId} FOR UPDATE`;
}

// ── Raise a request ─────────────────────────────────────
export async function raiseMaintenanceRequest(
  assetId: number,
  requesterId: number,
  description: string,
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
) {
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { status: true } });
  if (!asset) {
    throw fail(404, "asset_not_found", "That asset doesn't exist", "assetId");
  }
  if (NOT_MAINTAINABLE.includes(asset.status)) {
    throw notMaintainable(asset.status);
  }

  return prisma.maintenanceRequest.create({
    data: { assetId, requesterId, description, priority, status: "PENDING" },
  });
}

// ── Approve: PENDING -> APPROVED, asset -> UNDER_MAINTENANCE ──
export async function approveMaintenanceRequest(id: number, approverId: number) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const first = await tx.maintenanceRequest.findUnique({ where: { id } });
    if (!first) throw notFound();

    // Everything below runs under the asset's row lock, so two people approving
    // the same request (or two requests for the same asset) queue up instead of
    // interleaving.
    await lockAsset(tx, first.assetId);

    // Re-read under the lock: someone may have decided it while we waited.
    const request = await tx.maintenanceRequest.findUnique({ where: { id } });
    if (!request) throw notFound();
    if (request.status !== "PENDING") {
      throw fail(409, "invalid_transition", `Cannot approve a request in ${request.status} status`);
    }

    const asset = await tx.asset.findUnique({ where: { id: request.assetId } });
    if (!asset) throw fail(404, "asset_not_found", "That asset doesn't exist", "assetId");
    if (NOT_MAINTAINABLE.includes(asset.status)) throw notMaintainable(asset.status);

    const updated = await tx.maintenanceRequest.update({
      where: { id },
      data: { status: "APPROVED", approvedBy: approverId, approvedAt: new Date() },
    });

    // A second approved request on an asset that is already in maintenance
    // doesn't change the asset again.
    if (asset.status !== "UNDER_MAINTENANCE") {
      await tx.asset.update({ where: { id: request.assetId }, data: { status: "UNDER_MAINTENANCE" } });
      await tx.assetHistory.create({
        data: {
          assetId: request.assetId,
          fromStatus: asset.status,
          toStatus: "UNDER_MAINTENANCE",
          actorId: approverId,
          reason: "Maintenance approved",
        },
      });
    }

    return updated;
  });
}

// ── Reject: PENDING -> REJECTED (asset untouched) ───────
export async function rejectMaintenanceRequest(id: number, approverId: number) {
  const request = await prisma.maintenanceRequest.findUnique({ where: { id } });
  if (!request) throw notFound();
  if (request.status !== "PENDING") {
    throw fail(409, "invalid_transition", `Cannot reject a request in ${request.status} status`);
  }

  // Atomic: only one decision can flip the row out of PENDING.
  const decided = await prisma.maintenanceRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "REJECTED", approvedBy: approverId, approvedAt: new Date() },
  });
  if (decided.count === 0) {
    throw fail(409, "invalid_transition", "This request has already been decided");
  }
  return prisma.maintenanceRequest.findUniqueOrThrow({ where: { id } });
}

// ── Assign technician (status stays APPROVED; assignment is metadata) ──
export async function assignTechnician(id: number, technicianId: number) {
  const request = await prisma.maintenanceRequest.findUnique({ where: { id } });
  if (!request) throw notFound();
  if (request.status !== "APPROVED") {
    throw fail(409, "invalid_transition", "A technician can only be assigned to an approved request");
  }

  // There is no foreign key on technicianId, so check the person really exists.
  const technician = await prisma.user.findUnique({
    where: { id: technicianId },
    select: { status: true },
  });
  if (!technician || technician.status !== "ACTIVE") {
    throw fail(400, "invalid_technician", "Technician not found or inactive", "technicianId");
  }

  const assigned = await prisma.maintenanceRequest.updateMany({
    where: { id, status: "APPROVED" },
    data: { technicianId, assignedAt: new Date() },
  });
  if (assigned.count === 0) {
    throw fail(409, "invalid_transition", "A technician can only be assigned to an approved request");
  }
  return prisma.maintenanceRequest.findUniqueOrThrow({ where: { id } });
}

// ── Start work: APPROVED (+ technician assigned) -> IN_PROGRESS ──
export async function startMaintenanceRequest(id: number) {
  const request = await prisma.maintenanceRequest.findUnique({ where: { id } });
  if (!request) throw notFound();
  if (request.status !== "APPROVED") {
    throw fail(409, "invalid_transition", "Work can only start on an approved request");
  }
  if (!request.technicianId) {
    throw fail(409, "no_technician", "Assign a technician before starting work");
  }

  // Atomic: a double click or two tabs can't start the same request twice.
  const started = await prisma.maintenanceRequest.updateMany({
    where: { id, status: "APPROVED" },
    data: { status: "IN_PROGRESS" },
  });
  if (started.count === 0) {
    throw fail(409, "invalid_transition", "Work can only start on an approved request");
  }
  return prisma.maintenanceRequest.findUniqueOrThrow({ where: { id } });
}

// ── Resolve: IN_PROGRESS -> RESOLVED, asset back in service ──
export async function resolveMaintenanceRequest(id: number, resolverId: number, resolutionNotes?: string) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const first = await tx.maintenanceRequest.findUnique({ where: { id } });
    if (!first) throw notFound();

    await lockAsset(tx, first.assetId);

    const request = await tx.maintenanceRequest.findUnique({ where: { id } });
    if (!request) throw notFound();
    if (request.status !== "IN_PROGRESS") {
      throw fail(409, "invalid_transition", `Cannot resolve a request in ${request.status} status`);
    }

    const updated = await tx.maintenanceRequest.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolutionNotes },
    });

    const asset = await tx.asset.findUnique({ where: { id: request.assetId } });

    // Another approved / in-progress request is still open on this asset, so it
    // stays in maintenance until that one is resolved too.
    const stillOpen = await tx.maintenanceRequest.count({
      where: {
        assetId: request.assetId,
        id: { not: id },
        status: { in: ["APPROVED", "IN_PROGRESS"] },
      },
    });

    // Only bring the asset back if it is actually still UNDER_MAINTENANCE.
    // If it was marked LOST / RETIRED meanwhile, resolving must not resurrect it.
    if (stillOpen > 0 || !asset || asset.status !== "UNDER_MAINTENANCE") {
      return updated;
    }

    // If someone still holds the asset, it goes back to ALLOCATED, not AVAILABLE.
    const activeAllocation = await tx.allocation.findFirst({
      where: { assetId: request.assetId, status: "ACTIVE" },
      select: { id: true },
    });
    const nextStatus = activeAllocation ? "ALLOCATED" : "AVAILABLE";

    await tx.asset.update({ where: { id: request.assetId }, data: { status: nextStatus } });
    await tx.assetHistory.create({
      data: {
        assetId: request.assetId,
        fromStatus: "UNDER_MAINTENANCE",
        toStatus: nextStatus,
        actorId: resolverId,
        reason: "Maintenance resolved",
      },
    });

    return updated;
  });
}