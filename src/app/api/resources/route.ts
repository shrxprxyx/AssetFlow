import { NextResponse } from "next/server";
import { prisma } from "@/services/prisma";
import { requireAuth } from "@/services/guards";

// Bookable assets (rooms, vehicles, shared equipment) for the booking screen.
// Resources that can't be booked right now (in maintenance, lost, retired or
// disposed) are left out so people don't pick something that will be refused.
export async function GET() {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const resources = await prisma.asset.findMany({
    where: {
      isBookable: true,
      status: { notIn: ["UNDER_MAINTENANCE", "LOST", "RETIRED", "DISPOSED"] },
    },
    select: { id: true, assetTag: true, name: true, location: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ resources });
}