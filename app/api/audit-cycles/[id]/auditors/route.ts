import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWriteAuth } from "@/lib/guards";
import { auditorsSchema } from "@/lib/schemas";
import { validateAuditors } from "@/lib/audits";
import { logActivity } from "@/lib/logActivity";
import { readJson, validationError } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

async function loadActiveCycle(idParam: string) {
  const cycleId = Number(idParam);
  if (!Number.isInteger(cycleId) || cycleId <= 0) {
    return { error: NextResponse.json({ error: "invalid_id", message: "Invalid audit cycle id" }, { status: 400 }) };
  }
  const cycle = await prisma.auditCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) {
    return { error: NextResponse.json({ error: "not_found", message: "Audit cycle not found" }, { status: 404 }) };
  }
  if (cycle.status === "CLOSED") {
    return {
      error: NextResponse.json(
        { error: "cycle_closed", message: "This audit cycle is closed. Its auditors can't be changed." },
        { status: 409 }
      ),
    };
  }
  return { cycle };
}

// POST /api/audit-cycles/:id/auditors  { auditorIds: number[] }
// Admin adds auditors. People who are already assigned are skipped.
export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireWriteAuth("ADMIN");
  if (!guard.ok) return guard.response;

  const loaded = await loadActiveCycle((await params).id);
  if ("error" in loaded) return loaded.error;
  const { cycle } = loaded;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = auditorsSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);

  const auditors = await validateAuditors(parsed.data.auditorIds);
  if (!auditors.ok) {
    return NextResponse.json(
      { error: "validation_error", message: auditors.message, field: "auditorIds" },
      { status: 400 }
    );
  }

  const created = await prisma.auditAssignment.createMany({
    data: auditors.ids.map((auditorId) => ({ cycleId: cycle.id, auditorId })),
    skipDuplicates: true,
  });

  // Only the people who were actually added get told.
  const nowAssigned = await prisma.auditAssignment.findMany({
    where: { cycleId: cycle.id, auditorId: { in: auditors.ids } },
    orderBy: { assignedAt: "desc" },
    take: created.count,
    select: { auditorId: true },
  });
  for (const { auditorId } of nowAssigned) {
    await logActivity("audit_assigned", {
      actorId: guard.user.userId,
      resourceType: "AuditCycle",
      resourceId: cycle.id,
      changes: { auditorId, cycleName: cycle.name },
    });
  }

  return NextResponse.json({ added: created.count }, { status: created.count > 0 ? 201 : 200 });
}

// DELETE /api/audit-cycles/:id/auditors?auditorId=7
// Admin removes an auditor. At least one must remain.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const guard = await requireWriteAuth("ADMIN");
  if (!guard.ok) return guard.response;

  const loaded = await loadActiveCycle((await params).id);
  if ("error" in loaded) return loaded.error;
  const { cycle } = loaded;

  const auditorId = Number(new URL(req.url).searchParams.get("auditorId"));
  if (!Number.isInteger(auditorId) || auditorId <= 0) {
    return NextResponse.json(
      { error: "validation_error", message: "auditorId is required", field: "auditorId" },
      { status: 400 }
    );
  }

  const assignments = await prisma.auditAssignment.findMany({ where: { cycleId: cycle.id } });
  if (!assignments.some((a) => a.auditorId === auditorId)) {
    return NextResponse.json(
      { error: "not_found", message: "That person is not an auditor on this cycle" },
      { status: 404 }
    );
  }
  if (assignments.length <= 1) {
    return NextResponse.json(
      { error: "last_auditor", message: "A cycle needs at least one auditor. Add another before removing this one." },
      { status: 409 }
    );
  }

  await prisma.auditAssignment.deleteMany({ where: { cycleId: cycle.id, auditorId } });
  await logActivity("audit_auditor_removed", {
    actorId: guard.user.userId,
    resourceType: "AuditCycle",
    resourceId: cycle.id,
    changes: { auditorId },
  });

  return NextResponse.json({ ok: true });
}
