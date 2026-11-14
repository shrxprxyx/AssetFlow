import { prisma, Prisma } from "./prisma";

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
  purpose?: string
) {
  checkWindow(startTime, endTime);

  try {
    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

      return tx.resourceBooking.create({
        data: { resourceId, bookerId, startTime, endTime, purpose, status: "UPCOMING" },
      });
    });
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
 * Only upcoming bookings that haven't ended yet can be cancelled.
 */
export async function cancelBookingAs(actor: BookingActor, bookingId: number) {
  const booking = await prisma.resourceBooking.findUnique({ where: { id: bookingId } });
  if (!booking) throw fail(404, "not_found", "Booking not found");

  const isManager = actor.role === "ADMIN" || actor.role === "ASSET_MANAGER";
  if (booking.bookerId !== actor.userId && !isManager) {
    throw fail(403, "forbidden", "You can only cancel your own bookings");
  }
  if (booking.status === "CANCELLED") {
    throw fail(409, "already_cancelled", "This booking is already cancelled");
  }
  if (booking.status !== "UPCOMING" || booking.endTime.getTime() <= Date.now()) {
    throw fail(409, "booking_finished", "Bookings that have already happened can't be cancelled");
  }

  // Atomic: if two requests cancel at once, only one of them changes the row.
  const done = await prisma.resourceBooking.updateMany({
    where: { id: bookingId, status: "UPCOMING" },
    data: { status: "CANCELLED" },
  });
  if (done.count === 0) {
    throw fail(409, "already_cancelled", "This booking is already cancelled");
  }
  return prisma.resourceBooking.findUniqueOrThrow({ where: { id: bookingId } });
}