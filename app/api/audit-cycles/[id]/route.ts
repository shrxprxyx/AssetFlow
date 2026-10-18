import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAssetsInScope } from "@/lib/audits";
import { requireAuth } from "@/lib/guards";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth("ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const cycleId = Number(id);
  if (!Number.isInteger(cycleId) || cycleId <= 0) {
    return NextResponse.json(
      { error: "invalid_id", message: "Invalid audit cycle id" },
      { status: 400 }
    );
  }

  const cycle = await prisma.auditCycle.findUnique({
    where: { id: cycleId },
  });

  if (!cycle) {
    return NextResponse.json(
      { error: "not_found", message: "Audit cycle not found" },
      { status: 404 }
    );
  }

  const [assets, findings, department] = await Promise.all([
    getAssetsInScope(cycle.scopeType, cycle.scopeId),
    prisma.auditFinding.findMany({
      where: { cycleId },
    }),
    cycle.scopeId
      ? prisma.department.findUnique({
          where: { id: cycle.scopeId },
          select: { name: true },
        })
      : Promise.resolve(null),
  ]);

  const findingByAsset = new Map(findings.map((f) => [f.assetId, f]));

  const checklist = assets.map((asset) => ({
    asset,
    finding: findingByAsset.get(asset.id) ?? null,
  }));

  return NextResponse.json({
    cycle: {
      ...cycle,
      departmentName: department?.name ?? null,
    },
    checklist,
  });
}
