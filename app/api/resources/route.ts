import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/guards";

// Bookable assets (rooms, vehicles, shared equipment) for the booking screen.
export async function GET() {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const resources = await prisma.asset.findMany({
    where: { isBookable: true },
    select: { id: true, assetTag: true, name: true, location: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ resources });
}
