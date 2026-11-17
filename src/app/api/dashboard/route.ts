import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/guards";

export async function GET() {
  // Aggregate counts only — safe for every signed-in role.
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const now = new Date();

  const [available, allocated, maintenanceToday, activeBookings, pendingTransfers, overdue, upcoming] =
    await Promise.all([
      prisma.asset.count({ where: { status: "AVAILABLE" } }),
      prisma.asset.count({ where: { status: "ALLOCATED" } }),
      prisma.asset.count({ where: { status: "UNDER_MAINTENANCE" } }),
      prisma.resourceBooking.count({ where: { status: { in: ["UPCOMING", "ONGOING"] } } }),
      prisma.transferRequest.count({ where: { status: "PENDING" } }),
      prisma.allocation.count({
        where: { status: "ACTIVE", expectedReturnDate: { lt: now } },
      }),
      prisma.allocation.count({
        where: { status: "ACTIVE", expectedReturnDate: { gte: now } },
      }),
    ]);

  return NextResponse.json({
    available,
    allocated,
    maintenanceToday,
    activeBookings,
    pendingTransfers,
    overdue,
    upcomingReturns: upcoming,
  });
}
