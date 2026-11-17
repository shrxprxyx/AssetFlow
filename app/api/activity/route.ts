import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/guards";
import { parsePagination, paginated } from "@/lib/pagination";

// The tabs on the Activity screen. Actions are stored in lower_snake_case.
const CATEGORY_FILTERS: Record<string, Prisma.ActivityLogWhereInput> = {
  ALERTS: {
    action: { in: ["transfer_rejected", "maintenance_rejected", "booking_cancelled", "allocation_overdue"] },
  },
  APPROVALS: {
    OR: [{ action: { endsWith: "_approved" } }, { action: { endsWith: "_rejected" } }],
  },
  BOOKINGS: { action: { startsWith: "booking_" } },
};

// GET /api/activity?page=1&pageSize=25&category=ALERTS|APPROVALS|BOOKINGS
export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const { user } = guard;

  const { searchParams } = new URL(req.url);
  const paging = parsePagination(searchParams);
  if (!paging.ok) return paging.response;
  const { skip, take } = paging.page;

  const category = searchParams.get("category");
  if (category && category !== "ALL" && !CATEGORY_FILTERS[category]) {
    return NextResponse.json(
      {
        error: "validation_error",
        message: `category must be one of ALL, ${Object.keys(CATEGORY_FILTERS).join(", ")}`,
        field: "category",
      },
      { status: 400 }
    );
  }

  // Admins and Asset Managers see the full audit trail; everyone else only
  // sees their own actions instead of the whole organization's log.
  const canSeeAll = user.role === "ADMIN" || user.role === "ASSET_MANAGER";
  const where: Prisma.ActivityLogWhereInput = {
    ...(canSeeAll ? {} : { actorId: user.userId }),
    ...(category && category !== "ALL" ? CATEGORY_FILTERS[category] : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      // id breaks ties, so rows never jump between pages.
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      skip,
      take,
      include: { actor: { select: { firstName: true, lastName: true } } },
    }),
    prisma.activityLog.count({ where }),
  ]);

  return paginated(logs, total, paging.page);
}
