import { prisma, Prisma } from "./prisma";
import { recordActivity, dispatchActivity, type ActivitySpec } from "./outbox";

type HttpError = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, message: string, field?: string): HttpError => ({
  status,
  body: field ? { error, message, field } : { error, message },
});

async function lockAsset(tx: Prisma.TransactionClient, assetId: number) {
  await tx.$queryRaw`SELECT id FROM "Asset" WHERE id = ${assetId} FOR UPDATE`;
}

/* =====================================================
   Editing an asset's details
===================================================== */

export type AssetPatch = {
  name?: string;
  categoryId?: number;
  serialNumber?: string | null;
  acquisitionDate?: Date | null;
  acquisitionCost?: number | null;
  condition?: "GOOD" | "FAIR" | "POOR";
  location?: string | null;
  isBookable?: boolean;
  photoUrl?: string | null;
  notes?: string | null;
  /** The owning department; null takes the asset out of any department. */
  departmentId?: number | null;
};

/**
 * Why `id` can't be set as an asset's owning department, or null if it can:
 * it has to exist and be active. Takes the client or a transaction.
 */
export async function departmentProblem(
  db: Pick<Prisma.TransactionClient, "department">,
  id: number
): Promise<string | null> {
  const dept = await db.department.findUnique({ where: { id }, select: { status: true } });
  if (!dept) return "Department not found";
  if (dept.status !== "ACTIVE") return "Department is inactive";
  return null;
}

export async function updateAsset(
  assetId: number,
  patch: AssetPatch,
  /** Recorded in the same transaction as the edit (see services/outbox.ts). */
  activity?: ActivitySpec
) {
  let eventId: number | undefined;
  try {
    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockAsset(tx, assetId);

      const asset = await tx.asset.findUnique({ where: { id: assetId } });
      if (!asset) throw fail(404, "not_found", "Asset not found");
      if (asset.status === "DISPOSED") {
        throw fail(409, "asset_disposed", "A disposed asset can't be edited");
      }

      if (patch.categoryId !== undefined) {
        const category = await tx.assetCategory.findUnique({ where: { id: patch.categoryId } });
        if (!category) throw fail(400, "validation_error", "Category not found", "categoryId");
      }

      // Only check a department that is being newly assigned, so re-saving an
      // asset whose department was deactivated later doesn't fail.
      if (patch.departmentId != null && patch.departmentId !== asset.departmentId) {
        const problem = await departmentProblem(tx, patch.departmentId);
        if (problem) throw fail(400, "validation_error", problem, "departmentId");
      }

      // Don't pull a room out of service while people have it booked.
      if (patch.isBookable === false && asset.isBookable) {
        const upcoming = await tx.resourceBooking.count({
          where: { resourceId: assetId, status: { in: ["UPCOMING", "ONGOING"] }, endTime: { gt: new Date() } },
        });
        if (upcoming > 0) {
          throw fail(
            409,
            "has_upcoming_bookings",
            `Cancel the ${upcoming} upcoming booking(s) before making this asset non-bookable`,
            "isBookable"
          );
        }
      }

      const saved = await tx.asset.update({
        where: { id: assetId },
        data: patch,
        include: {
          category: { select: { name: true } },
          department: { select: { id: true, name: true } },
        },
      });
      if (activity) eventId = await recordActivity(tx, activity.action, activity);
      return saved;
    });
    if (eventId) await dispatchActivity(eventId);
    return updated;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw fail(409, "serial_taken", "An asset with this serial number already exists", "serialNumber");
    }
    throw err;
  }
}

/* =====================================================
   Lifecycle: lost / found / retired / disposed

   Statuses the system manages itself (ALLOCATED, UNDER_MAINTENANCE)
   can't be set by hand. Only these moves are allowed:

     AVAILABLE / RESERVED / ALLOCATED / UNDER_MAINTENANCE -> LOST
     AVAILABLE -> RETIRED
     LOST      -> AVAILABLE   (found again)
     RETIRED   -> DISPOSED
===================================================== */

export type LifecycleTarget = "AVAILABLE" | "LOST" | "RETIRED" | "DISPOSED";

const ALLOWED_MOVES: Record<string, string[]> = {
  AVAILABLE: ["LOST", "RETIRED"],
  RESERVED: ["LOST"],
  ALLOCATED: ["LOST"],
  UNDER_MAINTENANCE: ["LOST"],
  LOST: ["AVAILABLE"],
  RETIRED: ["DISPOSED"],
  DISPOSED: [],
};

const DEFAULT_REASON: Record<LifecycleTarget, string> = {
  LOST: "Marked as lost",
  RETIRED: "Retired from service",
  DISPOSED: "Disposed",
  AVAILABLE: "Found and returned to service",
};

export type StatusOutcome = {
  asset: { status: string };
  from: string;
  cancelledBookingIds: number[];
};

export async function changeAssetStatus(
  assetId: number,
  target: LifecycleTarget,
  actorId: number,
  reason?: string,
  /**
   * Events to record in the same transaction as the change (see services/outbox.ts),
   * built from its outcome: the status event, plus one per cancelled booking.
   */
  activities?: (outcome: StatusOutcome) => ActivitySpec[]
) {
  const eventIds: number[] = [];
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockAsset(tx, assetId);

    const asset = await tx.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw fail(404, "not_found", "Asset not found");

    const allowed = ALLOWED_MOVES[asset.status] ?? [];
    if (!allowed.includes(target)) {
      throw fail(
        409,
        "invalid_transition",
        `An asset that is ${asset.status.toLowerCase().replace("_", " ")} can't be moved to ${target.toLowerCase()}`
      );
    }

    // Someone may still be holding it.
    const activeAllocation = await tx.allocation.findFirst({
      where: { assetId, status: "ACTIVE" },
      select: { id: true },
    });

    if (target === "LOST" && activeAllocation) {
      // A lost asset can't stay allocated: close the allocation.
      await tx.allocation.updateMany({
        where: { assetId, status: "ACTIVE" },
        data: { status: "RETURNED", returnedDate: new Date(), returnNotes: "Asset reported lost" },
      });
    }

    // Anything that takes the asset out of service also cancels its upcoming bookings.
    let cancelledBookingIds: number[] = [];
    if (target === "LOST" || target === "RETIRED") {
      const upcoming = await tx.resourceBooking.findMany({
        where: { resourceId: assetId, status: { in: ["UPCOMING", "ONGOING"] }, endTime: { gt: new Date() } },
        select: { id: true },
      });
      cancelledBookingIds = upcoming.map((b: { id: number }) => b.id);
      if (cancelledBookingIds.length > 0) {
        await tx.resourceBooking.updateMany({
          where: { id: { in: cancelledBookingIds } },
          data: { status: "CANCELLED" },
        });
      }
    }

    // Found again: back to ALLOCATED if someone still holds it
    // (older data: audit closes used to leave the allocation open on a lost asset).
    const nextStatus =
      target === "AVAILABLE" && activeAllocation ? "ALLOCATED" : target;

    const updated = await tx.asset.update({
      where: { id: assetId },
      data: { status: nextStatus },
      include: { category: { select: { name: true } } },
    });

    await tx.assetHistory.create({
      data: {
        assetId,
        fromStatus: asset.status,
        toStatus: nextStatus,
        actorId,
        reason: reason?.trim() ? reason.trim() : DEFAULT_REASON[target],
      },
    });

    const outcome = { asset: updated, from: asset.status, cancelledBookingIds };
    for (const spec of activities?.(outcome) ?? []) {
      eventIds.push(await recordActivity(tx, spec.action, spec));
    }
    return outcome;
  });
  // After the commit. Never throws: if it can't reach the queue, the relay delivers it.
  for (const id of eventIds) await dispatchActivity(id);
  return result;
}