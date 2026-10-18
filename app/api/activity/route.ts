import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/guards";

export async function GET() {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const { user } = guard;

  // Admins and Asset Managers see the full audit trail; everyone else only
  // sees their own actions instead of the whole organization's log.
  const canSeeAll = user.role === "ADMIN" || user.role === "ASSET_MANAGER";

  const logs = await prisma.activityLog.findMany({
    where: canSeeAll ? {} : { actorId: user.userId },
    orderBy: { timestamp: "desc" },
    take: 20,
    include: { actor: { select: { firstName: true, lastName: true } } },
  });

  return NextResponse.json({ data: logs, total: logs.length });
}
