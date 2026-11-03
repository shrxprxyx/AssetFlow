import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import type { Role } from "./guards";

/**
 * Transfer workflow:  Requested -> Approved/Rejected -> (if approved) re-allocated.
 *
 *  - Employees can only ask for an asset for THEMSELVES, or hand off an asset
 *    THEY hold. Their request waits in PENDING.
 *  - Admins / Asset Managers already hold allocation authority, so a transfer
 *    they start is approved immediately (and still logged as a request).
 *  - Approval: Admin / Asset Manager for anything; Department Head only when the
 *    current holder is in their department. Nobody approves their own request.
 *  - Every state change runs under the asset's row lock, so two people deciding
 *    the same request (or two requests for the same asset) can't interleave.
 */

export type Actor = { userId: number; role: Role; departmentId: number | null };

type HttpError = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, message: string): HttpError => ({
  status,
  body: { error, message },
});

const isManager = (role: Role) => role === "ADMIN" || role === "ASSET_MANAGER";

async function lockAsset(tx: Prisma.TransactionClient, assetId: number) {
  await tx.$queryRaw`SELECT id FROM "Asset" WHERE id = ${assetId} FOR UPDATE`;
}

type HolderScope = {
  holderId: number | null;
  holderDeptId: number | null;
  holder?: { departmentId: number | null } | null;
} | null;

function canDecide(actor: Actor, current: HolderScope): boolean {
  if (isManager(actor.role)) return true;
  if (actor.role === "DEPARTMENT_HEAD" && actor.departmentId !== null && current) {
    return (
      current.holderDeptId === actor.departmentId ||
      current.holder?.departmentId === actor.departmentId
    );
  }
  return false;
}

// Performs the actual hand-over. Caller must hold the asset lock and have
// already verified `current` is the live ACTIVE allocation.
async function moveAsset(
  tx: Prisma.TransactionClient,
  p: {
    requestId: number;
    assetId: number;
    currentAllocationId: number;
    toHolderId: number;
    approverId: number;
    reason?: string | null;
  }
) {
  await tx.allocation.update({
    where: { id: p.currentAllocationId },
    data: {
      status: "RETURNED",
      returnedDate: new Date(),
      returnNotes: "Transferred to a new holder",
    },
  });

  const allocation = await tx.allocation.create({
    data: {
      assetId: p.assetId,
      holderId: p.toHolderId,
      holderType: "EMPLOYEE",
      status: "ACTIVE",
    },
  });

  await tx.assetHistory.create({
    data: {
      assetId: p.assetId,
      fromStatus: "ALLOCATED",
      toStatus: "ALLOCATED",
      actorId: p.approverId,
      reason: p.reason ? `Transferred: ${p.reason}` : "Transferred to a new holder",
    },
  });

  await tx.transferRequest.update({
    where: { id: p.requestId },
    data: { status: "APPROVED", approvedBy: p.approverId, approvedAt: new Date() },
  });

  return allocation;
}

/* ───────────────────────────── create ───────────────────────────── */

export async function createTransferRequest(
  actor: Actor,
  input: { assetId: number; toHolderId: number; reason?: string }
) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockAsset(tx, input.assetId);

    const asset = await tx.asset.findUnique({ where: { id: input.assetId } });
    if (!asset) throw fail(404, "not_found", "Asset not found");

    const current = await tx.allocation.findFirst({
      where: { assetId: input.assetId, status: "ACTIVE" },
    });
    if (!current) {
      throw fail(
        409,
        "not_allocated",
        "This asset isn't allocated to anyone, so there is nothing to transfer. Allocate it instead."
      );
    }
    if (current.holderId === input.toHolderId) {
      throw fail(400, "same_holder", "The asset is already held by that person");
    }

    const recipient = await tx.user.findUnique({ where: { id: input.toHolderId } });
    if (!recipient || recipient.status !== "ACTIVE") {
      throw fail(400, "invalid_recipient", "Recipient not found or inactive");
    }

    const manager = isManager(actor.role);
    const requestingForSelf = actor.userId === input.toHolderId;
    const handingOffOwn = current.holderId === actor.userId;
    if (!manager && !requestingForSelf && !handingOffOwn) {
      throw fail(
        403,
        "forbidden",
        "You can only request an asset for yourself, or hand off an asset you hold"
      );
    }

    const alreadyPending = await tx.transferRequest.findFirst({
      where: { assetId: input.assetId, status: "PENDING" },
    });
    if (alreadyPending) {
      throw fail(409, "transfer_pending", "A transfer request for this asset is already waiting for approval");
    }

    const request = await tx.transferRequest.create({
      data: {
        assetId: input.assetId,
        fromHolderId: current.holderId,
        toHolderId: input.toHolderId,
        requestedBy: actor.userId,
        reason: input.reason,
        status: "PENDING",
      },
    });

    if (!manager) {
      return { request, autoApproved: false };
    }

    await moveAsset(tx, {
      requestId: request.id,
      assetId: input.assetId,
      currentAllocationId: current.id,
      toHolderId: input.toHolderId,
      approverId: actor.userId,
      reason: input.reason,
    });
    const approved = await tx.transferRequest.findUniqueOrThrow({ where: { id: request.id } });
    return { request: approved, autoApproved: true };
  });
}

/* ───────────────────────────── approve ───────────────────────────── */

export async function approveTransfer(actor: Actor, requestId: number) {
  const outcome = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const first = await tx.transferRequest.findUnique({ where: { id: requestId } });
    if (!first) throw fail(404, "not_found", "Transfer request not found");

    await lockAsset(tx, first.assetId);

    // Re-read under the lock: someone may have decided it while we waited.
    const request = await tx.transferRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== "PENDING") {
      throw fail(409, "already_decided", "This request has already been decided");
    }
    if (request.requestedBy === actor.userId) {
      throw fail(403, "self_approval", "You can't approve your own request");
    }

    const current = await tx.allocation.findFirst({
      where: { assetId: request.assetId, status: "ACTIVE" },
      include: { holder: { select: { departmentId: true } } },
    });

    if (!canDecide(actor, current)) {
      throw fail(403, "forbidden", "You can't decide transfers for this asset");
    }

    const recipient = await tx.user.findUnique({ where: { id: request.toHolderId } });
    if (
      !current ||
      !recipient ||
      recipient.status !== "ACTIVE" ||
      (request.fromHolderId !== null && current.holderId !== request.fromHolderId)
    ) {
      // Commit the cancellation instead of throwing, so it isn't rolled back.
      await tx.transferRequest.update({
        where: { id: request.id },
        data: { status: "CANCELLED", approvedBy: actor.userId, approvedAt: new Date() },
      });
      return { stale: true as const };
    }

    const allocation = await moveAsset(tx, {
      requestId: request.id,
      assetId: request.assetId,
      currentAllocationId: current.id,
      toHolderId: request.toHolderId,
      approverId: actor.userId,
      reason: request.reason,
    });
    return { stale: false as const, allocation, assetId: request.assetId };
  });

  if (outcome.stale) {
    throw fail(
      409,
      "transfer_stale",
      "The asset's holder changed after this request was made, so the request was cancelled."
    );
  }
  return outcome;
}

/* ───────────────────────────── reject ───────────────────────────── */

export async function rejectTransfer(actor: Actor, requestId: number) {
  const request = await prisma.transferRequest.findUnique({ where: { id: requestId } });
  if (!request) throw fail(404, "not_found", "Transfer request not found");
  if (request.requestedBy === actor.userId) {
    throw fail(403, "self_approval", "You can't decide your own request. Cancel it instead.");
  }

  const current = await prisma.allocation.findFirst({
    where: { assetId: request.assetId, status: "ACTIVE" },
    include: { holder: { select: { departmentId: true } } },
  });
  if (!canDecide(actor, current)) {
    throw fail(403, "forbidden", "You can't decide transfers for this asset");
  }

  // Atomic: only one decision can flip the row out of PENDING.
  const updated = await prisma.transferRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "REJECTED", approvedBy: actor.userId, approvedAt: new Date() },
  });
  if (updated.count === 0) {
    throw fail(409, "already_decided", "This request has already been decided");
  }
  return { assetId: request.assetId };
}

/* ───────────────────────────── cancel ───────────────────────────── */

export async function cancelTransfer(actor: Actor, requestId: number) {
  const request = await prisma.transferRequest.findUnique({ where: { id: requestId } });
  if (!request) throw fail(404, "not_found", "Transfer request not found");

  if (request.requestedBy !== actor.userId && !isManager(actor.role)) {
    throw fail(403, "forbidden", "Only the person who asked can cancel a request");
  }

  const updated = await prisma.transferRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  if (updated.count === 0) {
    throw fail(409, "already_decided", "This request has already been decided");
  }
  return { assetId: request.assetId };
}

/* ───────────────────────────── list ───────────────────────────── */

export async function listTransfers(actor: Actor, scope: "PENDING" | "ALL") {
  let where: Prisma.TransferRequestWhereInput = scope === "PENDING" ? { status: "PENDING" } : {};
  let deptUserIds = new Set<number>();

  if (actor.role === "EMPLOYEE") {
    where = {
      ...where,
      OR: [
        { requestedBy: actor.userId },
        { fromHolderId: actor.userId },
        { toHolderId: actor.userId },
      ],
    };
  } else if (actor.role === "DEPARTMENT_HEAD") {
    const deptUsers = actor.departmentId
      ? await prisma.user.findMany({
          where: { departmentId: actor.departmentId },
          select: { id: true },
        })
      : [];
    deptUserIds = new Set(deptUsers.map((u) => u.id));
    where = {
      ...where,
      OR: [
        { requestedBy: actor.userId },
        { toHolderId: actor.userId },
        { fromHolderId: { in: Array.from(deptUserIds) } },
      ],
    };
  }

  const rows = await prisma.transferRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { asset: { select: { id: true, assetTag: true, name: true } } },
  });

  const ids = new Set<number>();
  for (const r of rows) {
    ids.add(r.toHolderId);
    ids.add(r.requestedBy);
    if (r.fromHolderId !== null) ids.add(r.fromHolderId);
  }
  const users = await prisma.user.findMany({
    where: { id: { in: Array.from(ids) } },
    select: { id: true, firstName: true, lastName: true },
  });
  const person = new Map(users.map((u) => [u.id, { id: u.id, name: `${u.firstName} ${u.lastName}` }]));

  return rows.map((r) => {
    const pending = r.status === "PENDING";
    const inScope =
      isManager(actor.role) ||
      (actor.role === "DEPARTMENT_HEAD" && r.fromHolderId !== null && deptUserIds.has(r.fromHolderId));
    return {
      id: r.id,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt,
      asset: r.asset,
      from: r.fromHolderId !== null ? person.get(r.fromHolderId) ?? null : null,
      to: person.get(r.toHolderId) ?? null,
      requestedBy: person.get(r.requestedBy) ?? null,
      // The UI shows buttons from these flags, so the server stays the authority.
      canDecide: pending && inScope && r.requestedBy !== actor.userId,
      canCancel: pending && (r.requestedBy === actor.userId || isManager(actor.role)),
    };
  });
}
