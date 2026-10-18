import { prisma, Prisma } from "./prisma";

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

export async function createBooking(
  resourceId: number,
  bookerId: number,
  startTime: Date,
  endTime: Date,
  purpose?: string
) {
  try {
    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Lock the RESOURCE row (the Asset). Unlike locking the existing bookings,
      // this works even for a resource's very first booking — there is always a
      // parent row to lock — so concurrent requests for the same resource run
      // one after another.
      const rows = await tx.$queryRaw<{ id: number; isBookable: boolean }[]>`
        SELECT id, "isBookable" FROM "Asset" WHERE id = ${resourceId} FOR UPDATE
      `;
      const resource = rows[0];

      if (!resource) {
        throw {
          status: 404,
          body: { error: "resource_not_found", message: "Resource not found" },
        } satisfies HttpError;
      }
      if (!resource.isBookable) {
        throw {
          status: 400,
          body: { error: "not_bookable", message: "This asset is not a bookable resource" },
        } satisfies HttpError;
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

export async function cancelBooking(bookingId: number) {
  return prisma.resourceBooking.update({
    where: { id: bookingId },
    data: { status: "CANCELLED" },
  });
}
