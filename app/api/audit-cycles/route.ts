import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auditCycleSchema } from "@/lib/schemas";
import { logActivity } from "@/lib/logActivity";
import { requireAuth } from "@/lib/guards";

// Same scoping rule as getAssetsInScope() in lib/audits.ts, but returns a count
// instead of loading every asset row for every cycle on the list page.
async function countAssetsInScope(scopeType: string, scopeId: number | null) {
  if (scopeType === "DEPARTMENT" && scopeId) {
    const department = await prisma.department.findUnique({
      where: { id: scopeId },
      select: { name: true },
    });
    if (!department) return 0;
    return prisma.asset.count({ where: { location: { contains: department.name } } });
  }
  return prisma.asset.count();
}

// GET /api/audit-cycles -> { cycles: [...with counts], departments: [...] }
export async function GET() {
  const guard = await requireAuth("ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD");
  if (!guard.ok) return guard.response;

  const [cycles, departments] = await Promise.all([
    prisma.auditCycle.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.department.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const grouped = cycles.length
    ? await prisma.auditFinding.groupBy({
        by: ["cycleId", "status"],
        where: { cycleId: { in: cycles.map((c) => c.id) } },
        _count: { _all: true },
      })
    : [];

  const assetCounts = await Promise.all(
    cycles.map((c) => countAssetsInScope(c.scopeType, c.scopeId))
  );

  const result = cycles.map((c, i) => {
    const mine = grouped.filter((g) => g.cycleId === c.id);
    const countOf = (s: string) => mine.find((g) => g.status === s)?._count._all ?? 0;
    return {
      ...c,
      assetCount: assetCounts[i],
      checkedCount: mine.reduce((sum, g) => sum + g._count._all, 0),
      missingCount: countOf("MISSING"),
      damagedCount: countOf("DAMAGED"),
    };
  });

  return NextResponse.json({ cycles: result, departments });
}

// POST /api/audit-cycles -> Admin creates a cycle
export async function POST(req: NextRequest) {
  const guard = await requireAuth("ADMIN");
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const parsed = auditCycleSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: "validation_error", message: issue.message, field: issue.path[0] },
      { status: 400 }
    );
  }
  const { name, scopeType, scopeId, startDate, endDate } = parsed.data;

  if (endDate < startDate) {
    return NextResponse.json(
      { error: "validation_error", message: "End date must be on or after the start date", field: "endDate" },
      { status: 400 }
    );
  }

  if (scopeType === "DEPARTMENT") {
    if (!scopeId) {
      return NextResponse.json(
        { error: "validation_error", message: "Pick a department for a department-scoped audit", field: "scopeId" },
        { status: 400 }
      );
    }
    const department = await prisma.department.findUnique({ where: { id: scopeId } });
    if (!department) {
      return NextResponse.json(
        { error: "validation_error", message: "Department not found", field: "scopeId" },
        { status: 400 }
      );
    }
  }

  const cycle = await prisma.auditCycle.create({
    data: {
      name,
      scopeType,
      scopeId: scopeType === "DEPARTMENT" ? scopeId : null,
      startDate,
      endDate,
      createdBy: guard.user.userId,
    },
  });

  await logActivity("audit_cycle_created", {
    actorId: guard.user.userId,
    resourceType: "AuditCycle",
    resourceId: cycle.id,
    changes: { name, scopeType, scopeId: cycle.scopeId },
  });

  return NextResponse.json({ cycle }, { status: 201 });
}
