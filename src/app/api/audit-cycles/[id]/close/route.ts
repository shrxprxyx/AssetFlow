import { NextRequest, NextResponse } from "next/server";
import { requireWriteAuth } from "@/lib/guards";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { recordActivity, dispatchActivity } from "@/lib/outbox";

// Thrown inside the transaction when another request closed the cycle first.
class AlreadyClosed extends Error {}
// Thrown inside the transaction when flagged findings still wait for a decision.
class UnresolvedDiscrepancies extends Error {
  constructor(public count: number) {
    super("unresolved discrepancies");
  }
}

const alreadyClosed = () =>
  NextResponse.json(
    { error: "already_closed", message: "This audit cycle is already closed" },
    { status: 409 }
  );

// A retired or disposed asset is already out of service; a "missing" finding
// doesn't bring it back into the lifecycle as LOST.
const NOT_MARKED_LOST = ["LOST", "RETIRED", "DISPOSED"];

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Role comes from the database, not the login token.
  const guard = await requireWriteAuth("ADMIN");
  if (!guard.ok) return guard.response;

  const cycleId = Number(id);

  if (!Number.isInteger(cycleId) || cycleId <= 0) {
    return NextResponse.json(
      { error: "invalid_id", message: "Invalid audit cycle id" },
      { status: 400 }
    );
  }

  const cycle = await prisma.auditCycle.findUnique({
    where: { id: cycleId },
  });

  if (!cycle) {
    return NextResponse.json(
      { error: "not_found", message: "Audit cycle not found" },
      { status: 404 }
    );
  }

  if (cycle.status === "CLOSED") return alreadyClosed();

  const adminId = guard.user.userId;

  let result;
  try {
    result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Claim the cycle first. If two people press "Close" at the same moment,
      // only one of them flips it from ACTIVE; the other stops here.
      const claimed = await tx.auditCycle.updateMany({
        where: { id: cycleId, status: "ACTIVE" },
        data: { status: "CLOSED", closedBy: adminId, closedAt: new Date() },
      });
      if (claimed.count === 0) throw new AlreadyClosed();

      // Every Missing / Damaged finding needs an Asset Manager's decision first.
      // Checked after claiming the cycle, so a decision can't slip in between the
      // check and the close; throwing rolls the claim back.
      const open = await tx.auditFinding.count({
        where: { cycleId, status: { in: ["MISSING", "DAMAGED"] }, resolutionStatus: "PENDING" },
      });
      if (open > 0) throw new UnresolvedDiscrepancies(open);

      const missingFindings = await tx.auditFinding.findMany({
        // Only confirmed (approved) missing assets become Lost.
        where: { cycleId, status: "MISSING", resolutionStatus: "APPROVED" },
        select: { assetId: true },
        orderBy: { assetId: "asc" }, // fixed lock order
      });

      const reason = `Flagged missing during audit cycle "${cycle.name}"`;
      const cancelledBookingIds: number[] = [];
      let allocationsClosed = 0;

      for (const { assetId } of missingFindings) {
        // Same lock the allocation, booking and lifecycle code take, so this
        // can't interleave with someone allocating or booking the asset.
        await tx.$queryRaw`SELECT id FROM "Asset" WHERE id = ${assetId} FOR UPDATE`;

        const asset = await tx.asset.findUnique({
          where: { id: assetId },
          select: { status: true },
        });
        if (!asset || NOT_MARKED_LOST.includes(asset.status)) continue;

        // A lost asset can't stay allocated: close the open allocation.
        const closedAllocations = await tx.allocation.updateMany({
          where: { assetId, status: "ACTIVE" },
          data: { status: "RETURNED", returnedDate: new Date(), returnNotes: reason },
        });
        allocationsClosed += closedAllocations.count;

        // ...and nobody can use it, so its upcoming bookings are cancelled.
        const upcoming = await tx.resourceBooking.findMany({
          where: {
            resourceId: assetId,
            status: { in: ["UPCOMING", "ONGOING"] },
            endTime: { gt: new Date() },
          },
          select: { id: true },
        });
        if (upcoming.length > 0) {
          const ids = upcoming.map((b: { id: number }) => b.id);
          await tx.resourceBooking.updateMany({
            where: { id: { in: ids } },
            data: { status: "CANCELLED" },
          });
          cancelledBookingIds.push(...ids);
        }

        await tx.asset.update({ where: { id: assetId }, data: { status: "LOST" } });
        await tx.assetHistory.create({
          data: {
            assetId,
            fromStatus: asset.status,
            toStatus: "LOST",
            actorId: adminId,
            reason,
          },
        });
      }

      const damagedCount = await tx.auditFinding.count({
        where: { cycleId, status: "DAMAGED", resolutionStatus: "APPROVED" },
      });

      const closed = await tx.auditCycle.findUniqueOrThrow({ where: { id: cycleId } });

      // The events are committed together with the close itself (see lib/outbox.ts):
      // a closed cycle can't exist without its audit entry and notifications.
      const discrepancyCount = missingFindings.length + damagedCount;
      const eventIds: number[] = [];
      eventIds.push(
        await recordActivity(tx, "audit_cycle_closed", {
          actorId: adminId,
          resourceType: "AuditCycle",
          resourceId: cycleId,
          changes: {
            discrepancyCount,
            allocationsClosed,
            bookingsCancelled: cancelledBookingIds.length,
          },
        })
      );
      // Tell the people whose bookings were cancelled (the notification skips the actor).
      for (const bookingId of cancelledBookingIds) {
        eventIds.push(
          await recordActivity(tx, "booking_cancelled", {
            actorId: adminId,
            resourceType: "ResourceBooking",
            resourceId: bookingId,
          })
        );
      }

      return {
        cycle: closed,
        eventIds,
        discrepancyCount,
        missingCount: missingFindings.length,
        damagedCount,
        allocationsClosed,
        cancelledBookingIds,
      };
    });
  } catch (err) {
    if (err instanceof AlreadyClosed) return alreadyClosed();
    if (err instanceof UnresolvedDiscrepancies) {
      return NextResponse.json(
        {
          error: "unresolved_discrepancies",
          message: `${err.count} flagged asset${err.count === 1 ? " still needs" : "s still need"} an approval or rejection before this cycle can be closed`,
          openCount: err.count,
        },
        { status: 409 }
      );
    }
    throw err;
  }

  const { cancelledBookingIds, eventIds, ...summary } = result;

  // Everything is committed. Dispatching never throws; anything it can't hand
  // over is delivered by the worker's relay.
  for (const eventId of eventIds) await dispatchActivity(eventId);

  return NextResponse.json({ ...summary, cancelledBookings: cancelledBookingIds.length });
}
