import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auditFindingSchema } from "@/lib/schemas";
import { logActivity } from "@/lib/logActivity";
import { requireAuth } from "@/lib/guards";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Only people who can run an audit may record findings. (With a single
  // implicit auditor per cycle, "auditor" = Admin or Asset Manager.)
  const guard = await requireAuth("ADMIN", "ASSET_MANAGER");
  if (!guard.ok) return guard.response;
  const auditorId = guard.user.userId;

  const cycleId = Number(id);
  if (!Number.isInteger(cycleId) || cycleId <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid audit cycle id" }, { status: 400 });
  }

  const cycle = await prisma.auditCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) {
    return NextResponse.json({ error: "not_found", message: "Audit cycle not found" }, { status: 404 });
  }
  if (cycle.status === "CLOSED") {
    return NextResponse.json(
      { error: "cycle_closed", message: "This audit cycle is closed — findings are locked" },
      { status: 409 }
    );
  }

  const body = await req.json();
  const parsed = auditFindingSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: "validation_error", message: issue.message, field: issue.path[0] },
      { status: 400 }
    );
  }
  const { assetId, status, auditorNotes } = parsed.data;

  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) {
    return NextResponse.json(
      { error: "validation_error", message: "Asset not found", field: "assetId" },
      { status: 400 }
    );
  }

  // Upsert-by-hand: (cycleId, assetId) isn't a DB-enforced unique pair in this
  // schema, and findings aren't a race-condition risk — one auditor clicking
  // through a checklist sequentially — so a find-then-write is enough here.
  const existing = await prisma.auditFinding.findFirst({ where: { cycleId, assetId } });

  const finding = existing
    ? await prisma.auditFinding.update({
        where: { id: existing.id },
        data: { status, auditorNotes, auditorId, conditionBefore: asset.condition },
      })
    : await prisma.auditFinding.create({
        data: { cycleId, assetId, auditorId, status, auditorNotes, conditionBefore: asset.condition },
      });

  await logActivity("audit_finding_recorded", {
    actorId: auditorId,
    resourceType: "AuditFinding",
    resourceId: finding.id,
    changes: { assetId, status },
  });

  return NextResponse.json({ finding });
}
