import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/services/prisma";
import { auditFindingSchema } from "@/utils/schemas";
import { recordActivity, dispatchActivity } from "@/services/outbox";
import { requireWriteAuth } from "@/services/guards";
import { isAssetInScope, isAssignedAuditor } from "@/services/audits";
import { readJson, validationError } from "@/utils/http";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Anyone who may audit can reach this far; whether they audit THIS cycle is
  // checked below against the cycle's assigned auditors.
  const guard = await requireWriteAuth("ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD");
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

  if (!(await isAssignedAuditor(cycleId, auditorId))) {
    return NextResponse.json(
      { error: "not_assigned", message: "You are not an assigned auditor on this audit cycle" },
      { status: 403 }
    );
  }

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = auditFindingSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);
  const { assetId, status, auditorNotes } = parsed.data;

  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) {
    return NextResponse.json(
      { error: "validation_error", message: "Asset not found", field: "assetId" },
      { status: 400 }
    );
  }

  // Only assets this cycle covers can be checked off.
  if (!(await isAssetInScope(cycle, assetId))) {
    return NextResponse.json(
      { error: "asset_out_of_scope", message: "This asset is not in the audit cycle's scope", field: "assetId" },
      { status: 400 }
    );
  }

  // One finding per asset per cycle (a unique index enforces it), so a second
  // click updates the first. If the verdict itself changes, an earlier
  // approval or rejection no longer applies and the finding goes back to pending.
  const existing = await prisma.auditFinding.findUnique({ where: { cycleId_assetId: { cycleId, assetId } } });
  const verdictChanged = !!existing && existing.status !== status;

  let eventId = 0;
  const finding = await prisma.$transaction(async (tx) => {
    const saved = await tx.auditFinding.upsert({
    where: { cycleId_assetId: { cycleId, assetId } },
    create: { cycleId, assetId, auditorId, status, auditorNotes, conditionBefore: asset.condition },
    update: {
      status,
      auditorNotes,
      auditorId,
      conditionBefore: asset.condition,
      ...(verdictChanged
        ? { resolutionStatus: "PENDING", resolvedBy: null, resolvedAt: null, resolutionNotes: null }
        : {}),
    },
    });
    // The event commits with the finding (see services/outbox.ts).
    eventId = await recordActivity(tx, "audit_finding_recorded", {
      actorId: auditorId,
      resourceType: "AuditFinding",
      resourceId: saved.id,
      changes: { assetId, status },
    });
    return saved;
  });
  await dispatchActivity(eventId);

  return NextResponse.json({ finding });
}
