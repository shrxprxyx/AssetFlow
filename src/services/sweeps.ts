import { prisma } from "./prisma";
import { recordActivity, dispatchActivity } from "./outbox";

const REMINDER_MINUTES = 15;

/**
 * Finds allocations whose return date has passed and tells people, once each.
 *
 * "Once" is remembered in the activity log: an allocation that already has an
 * `allocation_overdue` entry is skipped, so running the sweep again (or
 * restarting the worker) never sends the same reminder twice.
 *
 * Overdue allocations deliberately stay ACTIVE: that is the status the "one
 * holder per asset" database index protects, so the asset can't be handed to
 * someone else while it's still out.
 */
export async function runOverdueSweep(now: Date = new Date()) {
  const overdue = await prisma.allocation.findMany({
    where: { status: "ACTIVE", expectedReturnDate: { lt: now } },
    select: { id: true },
  });
  if (overdue.length === 0) return { overdue: 0, flagged: 0 };

  const already = await prisma.activityLog.findMany({
    where: {
      action: "allocation_overdue",
      resourceType: "Allocation",
      resourceId: { in: overdue.map((a: { id: number }) => a.id) },
    },
    select: { resourceId: true },
  });
  const done = new Set(already.map((a: { resourceId: number | null }) => a.resourceId));

  let flagged = 0;
  for (const allocation of overdue) {
    if (done.has(allocation.id)) continue;

    // Lock the allocation, then check again: two sweeps running at once (or one
    // that started before the asset came back) can't both record it.
    const eventId = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Allocation"
        WHERE id = ${allocation.id} AND "status"::text = 'ACTIVE' AND "expectedReturnDate" < ${now}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;
      const exists = await tx.activityLog.findFirst({
        where: { action: "allocation_overdue", resourceType: "Allocation", resourceId: allocation.id },
        select: { id: true },
      });
      if (exists) return null;
      return recordActivity(tx, "allocation_overdue", {
        actorId: null,
        resourceType: "Allocation",
        resourceId: allocation.id,
      });
    });
    if (eventId === null) continue;
    await dispatchActivity(eventId);
    flagged++;
  }
  return { overdue: overdue.length, flagged };
}

/**
 * Runs every minute:
 *  1. sends a reminder for bookings starting within the next 15 minutes (once),
 *  2. moves bookings UPCOMING -> ONGOING when they start,
 *  3. moves them to COMPLETED when they end.
 */
export async function runBookingTick(now: Date = new Date()) {
  // 1. Reminders. The booking is "claimed" with a guarded update first, so even
  //    two overlapping ticks can't send the same reminder twice.
  const soon = new Date(now.getTime() + REMINDER_MINUTES * 60_000);
  const due = await prisma.resourceBooking.findMany({
    where: { status: "UPCOMING", reminderSent: false, startTime: { gt: now, lte: soon } },
    select: { id: true },
  });

  let reminded = 0;
  for (const booking of due) {
    // The claim and the reminder event commit together. If the event can't be
    // written the claim is undone, so the next tick tries again instead of the
    // reminder being lost with the flag already set.
    const eventId = await prisma.$transaction(async (tx) => {
      const claimed = await tx.resourceBooking.updateMany({
        where: { id: booking.id, status: "UPCOMING", reminderSent: false },
        data: { reminderSent: true },
      });
      if (claimed.count !== 1) return null;
      return recordActivity(tx, "booking_reminder", {
        actorId: null,
        resourceType: "ResourceBooking",
        resourceId: booking.id,
      });
    });
    if (eventId === null) continue;
    await dispatchActivity(eventId);
    reminded++;
  }

  // 2 + 3. Status progression.
  const started = await prisma.resourceBooking.updateMany({
    where: { status: "UPCOMING", startTime: { lte: now }, endTime: { gt: now } },
    data: { status: "ONGOING" },
  });
  const completed = await prisma.resourceBooking.updateMany({
    where: { status: { in: ["UPCOMING", "ONGOING"] }, endTime: { lte: now } },
    data: { status: "COMPLETED" },
  });

  return { reminded, started: started.count, completed: completed.count };
}