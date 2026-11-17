import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/guards";
import { FLAGGED_STATUSES } from "@/lib/audits";

// GET /api/audit-cycles/:id/discrepancies
// The discrepancy report: every asset an auditor flagged as Missing or Damaged,
// with who flagged it and whether it has been approved or rejected yet.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth("ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD");
  if (!guard.ok) return guard.response;

  const cycleId = Number((await params).id);
  if (!Number.isInteger(cycleId) || cycleId <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid audit cycle id" }, { status: 400 });
  }

  const cycle = await prisma.auditCycle.findUnique({
    where: { id: cycleId },
    select: { id: true, name: true, status: true },
  });
  if (!cycle) {
    return NextResponse.json({ error: "not_found", message: "Audit cycle not found" }, { status: 404 });
  }

  const findings = await prisma.auditFinding.findMany({
    where: { cycleId, status: { in: [...FLAGGED_STATUSES] } },
    orderBy: [{ status: "asc" }, { id: "asc" }],
    include: {
      asset: { select: { id: true, assetTag: true, name: true, location: true, status: true } },
      auditor: { select: { firstName: true, lastName: true } },
    },
  });

  const count = (pred: (f: (typeof findings)[number]) => boolean) => findings.filter(pred).length;

  return NextResponse.json({
    cycle,
    summary: {
      total: findings.length,
      missing: count((f) => f.status === "MISSING"),
      damaged: count((f) => f.status === "DAMAGED"),
      pending: count((f) => f.resolutionStatus === "PENDING"),
      approved: count((f) => f.resolutionStatus === "APPROVED"),
      rejected: count((f) => f.resolutionStatus === "REJECTED"),
    },
    data: findings.map((f) => ({
      findingId: f.id,
      status: f.status,
      auditorNotes: f.auditorNotes,
      auditor: `${f.auditor.firstName} ${f.auditor.lastName}`,
      asset: f.asset,
      resolutionStatus: f.resolutionStatus,
      resolutionNotes: f.resolutionNotes,
      resolvedAt: f.resolvedAt,
    })),
  });
}
