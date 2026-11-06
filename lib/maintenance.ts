import { prisma, Prisma } from "./prisma";

// ── Raise a request ─────────────────────────────────────
export async function raiseMaintenanceRequest(
  assetId: number,
  requesterId: number,
  description: string,
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
) {
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) {
    throw { status: 400, body: { error: "asset_not_found", message: "That asset doesn't exist", field: "assetId" } };
  }

  return prisma.maintenanceRequest.create({
    data: { assetId, requesterId, description, priority, status: "PENDING" },
  });
}

// ── Approve: PENDING -> APPROVED, asset -> UNDER_MAINTENANCE ──
export async function approveMaintenanceRequest(id: number, approverId: number) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const request = await tx.maintenanceRequest.findUnique({ where: { id } });
    if (!request) {
      throw { status: 404, body: { error: "not_found", message: "Maintenance request not found" } };
    }
    if (request.status !== "PENDING") {
      throw {
        status: 409,
        body: { error: "invalid_transition", message: `Cannot approve a request in ${request.status} status` },
      };
    }

    const updated = await tx.maintenanceRequest.update({
      where: { id },
      data: { status: "APPROVED", approvedBy: approverId, approvedAt: new Date() },
    });

    const asset = await tx.asset.findUnique({ where: { id: request.assetId } });
    await tx.asset.update({ where: { id: request.assetId }, data: { status: "UNDER_MAINTENANCE" } });
    await tx.assetHistory.create({
      data: {
        assetId: request.assetId,
        fromStatus: asset?.status,
        toStatus: "UNDER_MAINTENANCE",
        actorId: approverId,
        reason: "Maintenance approved",
      },
    });

    return updated;
  });
}

// ── Reject: PENDING -> REJECTED (asset untouched) ───────
export async function rejectMaintenanceRequest(id: number, approverId: number) {
  const request = await prisma.maintenanceRequest.findUnique({ where: { id } });
  if (!request) {
    throw { status: 404, body: { error: "not_found", message: "Maintenance request not found" } };
  }
  if (request.status !== "PENDING") {
    throw {
      status: 409,
      body: { error: "invalid_transition", message: `Cannot reject a request in ${request.status} status` },
    };
  }

  return prisma.maintenanceRequest.update({
    where: { id },
    data: { status: "REJECTED", approvedBy: approverId, approvedAt: new Date() },
  });
}

// ── Assign technician (status stays APPROVED; assignment is metadata) ──
export async function assignTechnician(id: number, technicianId: number) {
  const request = await prisma.maintenanceRequest.findUnique({ where: { id } });
  if (!request) {
    throw { status: 404, body: { error: "not_found", message: "Maintenance request not found" } };
  }
  if (request.status !== "APPROVED") {
    throw {
      status: 409,
      body: { error: "invalid_transition", message: "A technician can only be assigned to an approved request" },
    };
  }

  return prisma.maintenanceRequest.update({
    where: { id },
    data: { technicianId, assignedAt: new Date() },
  });
}

// ── Start work: APPROVED (+ technician assigned) -> IN_PROGRESS ──
export async function startMaintenanceRequest(id: number) {
  const request = await prisma.maintenanceRequest.findUnique({ where: { id } });
  if (!request) {
    throw { status: 404, body: { error: "not_found", message: "Maintenance request not found" } };
  }
  if (request.status !== "APPROVED") {
    throw {
      status: 409,
      body: { error: "invalid_transition", message: "Work can only start on an approved request" },
    };
  }
  if (!request.technicianId) {
    throw {
      status: 409,
      body: { error: "no_technician", message: "Assign a technician before starting work" },
    };
  }

  return prisma.maintenanceRequest.update({ where: { id }, data: { status: "IN_PROGRESS" } });
}

// ── Resolve: IN_PROGRESS -> RESOLVED, asset -> AVAILABLE ──
export async function resolveMaintenanceRequest(id: number, resolverId: number, resolutionNotes?: string) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const request = await tx.maintenanceRequest.findUnique({ where: { id } });
    if (!request) {
      throw { status: 404, body: { error: "not_found", message: "Maintenance request not found" } };
    }
    if (request.status !== "IN_PROGRESS") {
      throw {
        status: 409,
        body: { error: "invalid_transition", message: `Cannot resolve a request in ${request.status} status` },
      };
    }

    const updated = await tx.maintenanceRequest.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolutionNotes },
    });

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
