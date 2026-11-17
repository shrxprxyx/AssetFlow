import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/services/prisma";
import { requireAuth } from "@/services/guards";
import { parsePagination, paginated } from "@/utils/pagination";

// GET /api/assets/:id/history?page=1&pageSize=25
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const assetId = Number(id);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid asset id" }, { status: 400 });
  }

  const paging = parsePagination(new URL(req.url).searchParams);
  if (!paging.ok) return paging.response;
  const { skip, take } = paging.page;

  const [rows, total] = await Promise.all([
    prisma.assetHistory.findMany({
      where: { assetId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take,
    }),
    prisma.assetHistory.count({ where: { assetId } }),
  ]);

  // AssetHistory has no relation to User in the schema, so look up actor names separately.
  const actorIds = [...new Set(rows.map((r) => r.actorId))];
  const users = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  const data = rows.map((r) => ({
    id: r.id,
    fromStatus: r.fromStatus,
    toStatus: r.toStatus,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    actor: byId.get(r.actorId) ?? null,
  }));

  return paginated(data, total, paging.page);
}
