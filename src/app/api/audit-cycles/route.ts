import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/services/prisma";
import { auditCycleSchema } from "@/utils/schemas";
import { countAssetsInScope, validateAuditors } from "@/services/audits";
import { readJson, validationError } from "@/utils/http";
import { recordActivity, dispatchActivity } from "@/services/outbox";
import { requireAuth, requireWriteAuth } from "@/services/guards";
import { parsePagination, paginated } from "@/utils/pagination";

// GET /api/audit-cycles?page=1&pageSize=25
//   -> { data: [...cycles with counts], total, page, pageSize, departments: [...] }
export async function GET(req: NextRequest) {
  const guard = await requireAuth("ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD");
  if (!guard.ok) return guard.response;

  const paging = parsePagination(new URL(req.url).searchParams);
  if (!paging.ok) return paging.response;
  const { skip, take } = paging.page;

  const [cycles, total, departments] = await Promise.all([
    prisma.auditCycle.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take,
    }),
    prisma.auditCycle.count(),
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

  const assigned = cycles.length
    ? await prisma.auditAssignment.groupBy({
        by: ["cycleId"],
        where: { cycleId: { in: cycles.map((c) => c.id) } },
        _count: { _all: true },
      })
    : [];

  const assetCounts = await Promise.all(
    cycles.map((c) => countAssetsInScope(c))
  );

  const result = cycles.map((c, i) => {
    const mine = grouped.filter((g) => g.cycleId === c.id);
    const countOf = (s: string) => mine.find((g) => g.status === s)?._count._all ?? 0;
    return {
      ...c,
      assetCount: assetCounts[i],
      auditorCount: assigned.find((a) => a.cycleId === c.id)?._count._all ?? 0,
      checkedCount: mine.reduce((sum, g) => sum + g._count._all, 0),
      missingCount: countOf("MISSING"),
      damagedCount: countOf("DAMAGED"),
    };
  });

  return paginated(result, total, paging.page, { departments });
}

// POST /api/audit-cycles -> Admin creates a cycle
export async function POST(req: NextRequest) {
  const guard = await requireWriteAuth("ADMIN");
  if (!guard.ok) return guard.response;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = auditCycleSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);
  const { name, scopeType, scopeId, scopeLocation, startDate, endDate, auditorIds } = parsed.data;

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

  if (scopeType === "LOCATION" && !scopeLocation) {
    return NextResponse.json(
      { error: "validation_error", message: "Enter a location for a location-scoped audit", field: "scopeLocation" },
      { status: 400 }
    );
  }

  const auditors = await validateAuditors(auditorIds);
  if (!auditors.ok) {
    return NextResponse.json(
      { error: "validation_error", message: auditors.message, field: "auditorIds" },
      { status: 400 }
    );
  }

  // The cycle, its auditors and their events are created together or not at all
  // (see services/outbox.ts).
  const eventIds: number[] = [];
  const cycle = await prisma.$transaction(async (tx) => {
    const created = await tx.auditCycle.create({
      data: {
        name,
        scopeType,
        scopeId: scopeType === "DEPARTMENT" ? scopeId : null,
        scopeLocation: scopeType === "LOCATION" ? scopeLocation : null,
        startDate,
        endDate,
        createdBy: guard.user.userId,
      },
    });
    await tx.auditAssignment.createMany({
      data: auditors.ids.map((auditorId) => ({ cycleId: created.id, auditorId })),
    });
    eventIds.push(
      await recordActivity(tx, "audit_cycle_created", {
        actorId: guard.user.userId,
        resourceType: "AuditCycle",
        resourceId: created.id,
        changes: { name, scopeType, scopeId: created.scopeId, scopeLocation: created.scopeLocation, auditorIds: auditors.ids },
      })
    );
    // Tell each auditor they were picked (the admin doesn't need telling).
    for (const auditorId of auditors.ids) {
      if (auditorId === guard.user.userId) continue;
      eventIds.push(
        await recordActivity(tx, "audit_assigned", {
          actorId: guard.user.userId,
          resourceType: "AuditCycle",
          resourceId: created.id,
          changes: { auditorId, cycleName: name },
        })
      );
    }
    return created;
  });
  for (const id of eventIds) await dispatchActivity(id);

  return NextResponse.json({ cycle }, { status: 201 });
}