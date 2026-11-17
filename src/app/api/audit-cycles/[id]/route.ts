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

  const [assets, findings, department, assignments] = await Promise.all([
    getAssetsInScope(cycle),
    prisma.auditFinding.findMany({
      where: { cycleId },
    }),
    cycle.scopeId
      ? prisma.department.findUnique({
          where: { id: cycle.scopeId },
          select: { name: true },
        })
      : Promise.resolve(null),
    prisma.auditAssignment.findMany({
      where: { cycleId },
      orderBy: { assignedAt: "asc" },
      include: { auditor: { select: { id: true, firstName: true, lastName: true, role: true } } },
    }),
  ]);

  const findingByAsset = new Map(findings.map((f) => [f.assetId, f]));

  const checklist = assets.map((asset) => ({
    asset,
    finding: findingByAsset.get(asset.id) ?? null,
  }));

  const auditors = assignments.map((a) => ({
    id: a.auditor.id,
    name: `${a.auditor.firstName} ${a.auditor.lastName}`,
    role: a.auditor.role,
  }));
  const me = guard.user;

  return NextResponse.json({
    cycle: {
      ...cycle,
      departmentName: department?.name ?? null,
    },
    auditors,
    // What this person may do here. The buttons follow these; the API enforces them.
    permissions: {
      canRecord: cycle.status === "ACTIVE" && auditors.some((a) => a.id === me.userId),
      canResolve: cycle.status === "ACTIVE" && (me.role === "ADMIN" || me.role === "ASSET_MANAGER"),
      canManageAuditors: cycle.status === "ACTIVE" && me.role === "ADMIN",
    },
    checklist,
  });
}
