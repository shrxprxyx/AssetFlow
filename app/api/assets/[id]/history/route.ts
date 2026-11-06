import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/guards";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const assetId = Number(id);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid asset id" }, { status: 400 });
  }

  const rows = await prisma.assetHistory.findMany({
    where: { assetId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

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

  return NextResponse.json({ data });
}
