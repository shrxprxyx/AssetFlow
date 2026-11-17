import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/services/prisma";
import { requireWriteAuth } from "@/services/guards";
import { discrepancyResolutionSchema } from "@/utils/schemas";
import { FLAGGED_STATUSES } from "@/services/audits";
import { recordActivity, dispatchActivity } from "@/services/outbox";
import { readJson, validationError } from "@/utils/http";

// PATCH /api/audit-cycles/:id/findings/:findingId/resolution
//   { decision: "APPROVED" | "REJECTED", notes?: string }
// An Asset Manager (or Admin) decides on a discrepancy an auditor flagged.
//   APPROVED: the finding is confirmed. Closing the cycle then marks a
//             confirmed-missing asset Lost.
//   REJECTED: the finding is dismissed (e.g. the asset turned up). Nothing changes.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; findingId: string }> }
) {
  const guard = await requireWriteAuth("ADMIN", "ASSET_MANAGER");
  if (!guard.ok) return guard.response;

  const { id, findingId: findingParam } = await params;
  const cycleId = Number(id);
  const findingId = Number(findingParam);
  if (!Number.isInteger(cycleId) || cycleId <= 0 || !Number.isInteger(findingId) || findingId <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid id" }, { status: 400 });
  }

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = discrepancyResolutionSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);
  const { decision, notes } = parsed.data;

  const finding = await prisma.auditFinding.findFirst({
    where: { id: findingId, cycleId },
    include: { cycle: { select: { status: true } } },
  });
  if (!finding) {
    return NextResponse.json({ error: "not_found", message: "Finding not found in this audit cycle" }, { status: 404 });
  }
  if (finding.cycle.status === "CLOSED") {
    return NextResponse.json(
      { error: "cycle_closed", message: "This audit cycle is closed. Decisions are locked." },
      { status: 409 }
    );
  }
  if (!(FLAGGED_STATUSES as readonly string[]).includes(finding.status)) {
    return NextResponse.json(
      { error: "not_a_discrepancy", message: "Only Missing or Damaged findings need a decision" },
      { status: 409 }
    );
  }

  // The event commits with the decision (see services/outbox.ts).
  let eventId = 0;
  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.auditFinding.update({
      where: { id: findingId },
      data: {
        resolutionStatus: decision,
        resolvedBy: guard.user.userId,
        resolvedAt: new Date(),
        resolutionNotes: notes || null,
      },
    });
    eventId = await recordActivity(tx, "audit_discrepancy_resolved", {
      actorId: guard.user.userId,
      resourceType: "AuditFinding",
      resourceId: findingId,
      changes: { decision, assetId: finding.assetId, status: finding.status },
    });
    return saved;
  });
  await dispatchActivity(eventId);

  return NextResponse.json({ finding: updated });
}
