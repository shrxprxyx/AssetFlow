import { prisma, Prisma } from "./prisma";
import type { ResourceBooking } from "@prisma/client";
import { recordFor, dispatchActivity, type ActivityFor } from "./outbox";

// Booking rules
const MAX_BOOKING_HOURS = 12;
const PAST_GRACE_MS = 60_000; // tolerate a minute of clock drift between browser and server
// A resource in one of these states can't be booked.
const UNAVAILABLE_STATUSES: string[] = ["UNDER_MAINTENANCE", "LOST", "RETIRED", "DISPOSED"];

export async function getBookingsForResource(resourceId: number, date: Date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  return prisma.resourceBooking.findMany({
    where: {
      resourceId,
      status: { not: "CANCELLED" },
      startTime: { lte: dayEnd },
      endTime: { gte: dayStart },
    },
    include: { booker: { select: { firstName: true, lastName: true } } },
    orderBy: { startTime: "asc" },
  });
}

type HttpError = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, message: string, field?: string): HttpError => ({
  status,
  body: field ? { error, message, field } : { error, message },
});

function overlapError(conflicting?: { startTime: Date; endTime: Date }): HttpError {
  return {
    status: 409,
    body: {
      error: "booking_overlap",
      message: "This slot is unavailable — it overlaps an existing booking.",
      conflictingBooking: conflicting
        ? { startTime: conflicting.startTime, endTime: conflicting.endTime }
        : undefined,
    },
  };
}

// Postgres raises SQLSTATE 23P01 when the "booking_no_overlap" exclusion
// constraint rejects a row. Prisma doesn't map that code, so match on the text.
function isExclusionViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : "";
  return msg.includes("booking_no_overlap") || msg.includes("23P01");
}

function checkWindow(startTime: Date, endTime: Date) {
  if (startTime.getTime() < Date.now() - PAST_GRACE_MS) {
    throw fail(400, "validation_error", "Start time can't be in the past", "startTime");
  }
  if (endTime.getTime() - startTime.getTime() > MAX_BOOKING_HOURS * 3_600_000) {
    throw fail(
      400,
      "validation_error",
      `A booking can't be longer than ${MAX_BOOKING_HOURS} hours`,
      "endTime"
    );
  }
}

export async function createBooking(
  resourceId: number,
  bookerId: number,
  startTime: Date,
  endTime: Date,
  purpose?: string,
  /** Recorded in the same transaction as the booking (see services/outbox.ts). */
  activity?: ActivityFor<ResourceBooking>
) {
  checkWindow(startTime, endTime);

  try {
    const { booking, eventId } = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Lock the RESOURCE row (the Asset). Unlike locking the existing bookings,
      // this works even for a resource's very first booking — there is always a
      // parent row to lock — so concurrent requests for the same resource run
      // one after another.
      const rows = await tx.$queryRaw<{ id: number; isBookable: boolean; status: string }[]>`
        SELECT id, "isBookable", "status"::text AS status FROM "Asset" WHERE id = ${resourceId} FOR UPDATE
      `;
      const resource = rows[0];

      if (!resource) {
        throw fail(404, "resource_not_found", "Resource not found");
      }
      if (!resource.isBookable) {
        throw fail(400, "not_bookable", "This asset is not a bookable resource");
      }
      if (UNAVAILABLE_STATUSES.includes(resource.status)) {
        throw fail(
          409,
          "resource_unavailable",
          `This resource is ${resource.status.toLowerCase().replace("_", " ")} and can't be booked`
        );
      }

      const overlapping = await tx.resourceBooking.findFirst({
        where: {
          resourceId,
          status: { not: "CANCELLED" },
          startTime: { lt: endTime },
          endTime: { gt: startTime },
        },
      });

      if (overlapping) {
        throw overlapError(overlapping);
      }

      const booking = await tx.resourceBooking.create({
        data: { resourceId, bookerId, startTime, endTime, purpose, status: "UPCOMING" },
      });
      return { booking, eventId: await recordFor(tx, activity, booking) };
    });
    if (eventId) await dispatchActivity(eventId);
    return booking;
  } catch (err) {
    // Backstop: the database's exclusion constraint caught an overlap that
    // somehow slipped past the check above.
    if (isExclusionViolation(err)) throw overlapError();
    throw err;
  }
}

/** Plain status flip, no permission checks. Use cancelBookingAs() from API routes. */
export async function cancelBooking(bookingId: number) {
  return prisma.resourceBooking.update({
    where: { id: bookingId },
    data: { status: "CANCELLED" },
  });
}

export type BookingActor = { userId: number; role: string };

/**
 * Cancel a booking on someone's behalf.
 * Allowed: the person who made it, or an Admin / Asset Manager.
 * Upcoming and in-progress bookings that haven't ended yet can be cancelled.
 */
export async function cancelBookingAs(
  actor: BookingActor,
  bookingId: number,
  /** Recorded in the same transaction as the cancellation (see services/outbox.ts). */
  activity?: ActivityFor<ResourceBooking>
) {
  const booking = await prisma.resourceBooking.findUnique({ where: { id: bookingId } });
  if (!booking) throw fail(404, "not_found", "Booking not found");

  const isManager = actor.role === "ADMIN" || actor.role === "ASSET_MANAGER";
  if (booking.bookerId !== actor.userId && !isManager) {
    throw fail(403, "forbidden", "You can only cancel your own bookings");
  }
  if (booking.status === "CANCELLED") {
    throw fail(409, "already_cancelled", "This booking is already cancelled");
  }
  if (booking.status === "COMPLETED" || booking.endTime.getTime() <= Date.now()) {
    throw fail(409, "booking_finished", "Bookings that have already happened can't be cancelled");
  }

  // Atomic: if two requests cancel at once, only one of them changes the row.
  // (An in-progress booking can still be cancelled to free the room early.)
  const { updated, eventId } = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const done = await tx.resourceBooking.updateMany({
      where: { id: bookingId, status: { in: ["UPCOMING", "ONGOING"] } },
      data: { status: "CANCELLED" },
    });
    if (done.count === 0) {
      throw fail(409, "already_cancelled", "This booking is already cancelled");
    }
    const updated = await tx.resourceBooking.findUniqueOrThrow({ where: { id: bookingId } });
    return { updated, eventId: await recordFor(tx, activity, updated) };
  });
  if (eventId) await dispatchActivity(eventId);
  return updated;
}

/**
 * Move an upcoming booking to a new time (and optionally change its purpose).
 * Allowed: the person who made it, or an Admin / Asset Manager.
 *
 * Runs under the same resource lock as createBooking(), so two people can't
 * take the same slot, and the booking may overlap its own old time. The
 * reminder is re-armed for the new time.
 */
export async function rescheduleBookingAs(
  actor: BookingActor,
  bookingId: number,
  startTime: Date,
  endTime: Date,
  purpose?: string,
  /** Recorded in the same transaction as the change (see services/outbox.ts). */
  activity?: ActivityFor<ResourceBooking & { previousStartTime: Date; previousEndTime: Date }>
) {
  const first = await prisma.resourceBooking.findUnique({ where: { id: bookingId } });
  if (!first) throw fail(404, "not_found", "Booking not found");

  const isManager = actor.role === "ADMIN" || actor.role === "ASSET_MANAGER";
  if (first.bookerId !== actor.userId && !isManager) {
    throw fail(403, "forbidden", "You can only reschedule your own bookings");
  }
  checkWindow(startTime, endTime);

  try {
    const { updated, eventId } = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const rows = await tx.$queryRaw<{ id: number; isBookable: boolean; status: string }[]>`
        SELECT id, "isBookable", "status"::text AS status FROM "Asset" WHERE id = ${first.resourceId} FOR UPDATE
      `;
      const resource = rows[0];
      if (!resource || !resource.isBookable) {
        throw fail(400, "not_bookable", "This asset is not a bookable resource");
      }
      if (UNAVAILABLE_STATUSES.includes(resource.status)) {
        throw fail(
          409,
          "resource_unavailable",
          `This resource is ${resource.status.toLowerCase().replace("_", " ")} and can't be booked`
        );
      }

      // Re-read under the lock: it may have been cancelled or started while we waited.
      const booking = await tx.resourceBooking.findUnique({ where: { id: bookingId } });
      if (!booking) throw fail(404, "not_found", "Booking not found");
      if (booking.status === "CANCELLED") {
        throw fail(409, "already_cancelled", "This booking is cancelled, so it can't be moved");
      }
      if (booking.status !== "UPCOMING" || booking.startTime.getTime() <= Date.now()) {
        throw fail(409, "booking_started", "Only a booking that hasn't started yet can be rescheduled");
      }

      const overlapping = await tx.resourceBooking.findFirst({
        where: {
          resourceId: booking.resourceId,
          id: { not: bookingId },
          status: { not: "CANCELLED" },
          startTime: { lt: endTime },
          endTime: { gt: startTime },
        },
      });
      if (overlapping) throw overlapError(overlapping);

      const updated = await tx.resourceBooking.update({
        where: { id: bookingId },
        data: { startTime, endTime, reminderSent: false, ...(purpose !== undefined && { purpose }) },
      });
      const eventId = await recordFor(tx, activity, {
        ...updated,
        previousStartTime: booking.startTime,
        previousEndTime: booking.endTime,
      });
      return { updated, eventId };
    });
    if (eventId) await dispatchActivity(eventId);
    return updated;
  } catch (err) {
    if (isExclusionViolation(err)) throw overlapError();
    throw err;
  }
}
