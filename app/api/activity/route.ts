import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/guards";
import { parsePagination, paginated } from "@/lib/pagination";

// GET /api/activity?page=1&pageSize=25
export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const { user } = guard;

  const paging = parsePagination(new URL(req.url).searchParams);
  if (!paging.ok) return paging.response;
  const { skip, take } = paging.page;

  // Admins and Asset Managers see the full audit trail; everyone else only
  // sees their own actions instead of the whole organization's log.
  const canSeeAll = user.role === "ADMIN" || user.role === "ASSET_MANAGER";
  const where = canSeeAll ? {} : { actorId: user.userId };

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
