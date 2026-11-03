import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/guards";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { logActivity } from "@/lib/logActivity";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Role comes from the database, not the login token.
  const guard = await requireAuth("ADMIN");
  if (!guard.ok) return guard.response;

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
      {
        error: "not_found",
        message: "Audit cycle not found",
      },
      { status: 404 }
    );
  }

  if (cycle.status === "CLOSED") {
    return NextResponse.json(
      {
        error: "already_closed",
        message: "This audit cycle is already closed",
      },
      { status: 409 }
    );
  }

  const adminId = guard.user.userId;

  const result = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const missingFindings = await tx.auditFinding.findMany({
        where: {
          cycleId,
          status: "MISSING",
        },
        include: {
          asset: true,
        },
      });

      for (const finding of missingFindings) {
        if (finding.asset.status !== "LOST") {
          await tx.asset.update({
            where: { id: finding.assetId },
            data: { status: "LOST" },
          });

          await tx.assetHistory.create({
            data: {
              assetId: finding.assetId,
              fromStatus: finding.asset.status,
              toStatus: "LOST",
              actorId: adminId,
              reason: `Flagged missing during audit cycle "${cycle.name}"`,
            },
          });
        }
      }

      const damagedCount = await tx.auditFinding.count({
        where: {
          cycleId,
          status: "DAMAGED",
        },
      });

      const closed = await tx.auditCycle.update({
        where: { id: cycleId },
        data: {
          status: "CLOSED",
          closedBy: adminId,
          closedAt: new Date(),
        },
      });

      return {
        cycle: closed,
        discrepancyCount: missingFindings.length + damagedCount,
        missingCount: missingFindings.length,
        damagedCount,
      };
    }
  );

  await logActivity("audit_cycle_closed", {
    actorId: adminId,
    resourceType: "AuditCycle",
    resourceId: cycleId,
    changes: {
      discrepancyCount: result.discrepancyCount,
    },
  });

  return NextResponse.json(result);
}