import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/logActivity";
import { requireAuth } from "@/lib/guards";
import { readJson, validationError } from "@/lib/http";
import {
  approveMaintenanceRequest,
  rejectMaintenanceRequest,
  assignTechnician,
  startMaintenanceRequest,
  resolveMaintenanceRequest,
} from "@/lib/maintenance";

// Kept local rather than added to lib/schemas.ts to avoid touching a
// shared file mid-build — fold into schemas.ts at the next merge sync.
const maintenancePatchSchema = z
  .object({
    status: z.enum(["APPROVED", "REJECTED", "IN_PROGRESS", "RESOLVED"]).optional(),
    technicianId: z.coerce.number().int().positive().optional(),
    resolutionNotes: z.string().max(1000).optional(),
  })
  .refine((data) => data.status || data.technicianId, {
    message: "Provide a status transition or a technicianId to assign",
  });

const MANAGER_ROLES = ["ASSET_MANAGER", "ADMIN"];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Role comes from the database, not the login token.
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const { user } = guard;

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid request id" }, { status: 400 });
  }

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = maintenancePatchSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);

  const actorId = user.userId;
  const isManager = MANAGER_ROLES.includes(user.role);
  const { status, technicianId, resolutionNotes } = parsed.data;

  try {
    // Approve / Reject — Asset Manager or Admin only
    if (status === "APPROVED" || status === "REJECTED") {
      if (!isManager) {
        return NextResponse.json(
          { error: "forbidden", message: "Only an Asset Manager or Admin can approve or reject requests" },
          { status: 403 }
        );
      }
      const updated =
        status === "APPROVED"
          ? await approveMaintenanceRequest(id, actorId)
          : await rejectMaintenanceRequest(id, actorId);
      await logActivity(status === "APPROVED" ? "maintenance_approved" : "maintenance_rejected", {
        actorId,
        resourceType: "MaintenanceRequest",
        resourceId: id,
      });
      return NextResponse.json({ request: updated });
    }

    // Assign technician — no status change, just metadata
    if (technicianId && !status) {
      if (!isManager) {
        return NextResponse.json(
          { error: "forbidden", message: "Only an Asset Manager or Admin can assign a technician" },
          { status: 403 }
        );
      }
      const updated = await assignTechnician(id, technicianId);
      await logActivity("maintenance_technician_assigned", {
        actorId,
        resourceType: "MaintenanceRequest",
        resourceId: id,
      });
      return NextResponse.json({ request: updated });
    }

    // Start / resolve work — a manager, or the technician assigned to THIS request
    if (status === "IN_PROGRESS" || status === "RESOLVED") {
      const existing = await prisma.maintenanceRequest.findUnique({
        where: { id },
        select: { technicianId: true },
      });
      if (!existing) {
        return NextResponse.json({ error: "not_found", message: "Maintenance request not found" }, { status: 404 });
      }
      const isAssignedTechnician = existing.technicianId === actorId;
      if (!isManager && !isAssignedTechnician) {
        return NextResponse.json(
          {
            error: "forbidden",
            message: "Only an Asset Manager, Admin, or the assigned technician can do this",
          },
          { status: 403 }
        );
      }

      if (status === "IN_PROGRESS") {
        const updated = await startMaintenanceRequest(id);
        await logActivity("maintenance_in_progress", {
          actorId,
          resourceType: "MaintenanceRequest",
          resourceId: id,
        });
        return NextResponse.json({ request: updated });
      }

      const updated = await resolveMaintenanceRequest(id, actorId, resolutionNotes);
      await logActivity("maintenance_resolved", {
        actorId,
        resourceType: "MaintenanceRequest",
        resourceId: id,
      });
      return NextResponse.json({ request: updated });
    }

    return NextResponse.json({ error: "no_op", message: "No valid transition in request body" }, { status: 400 });
  } catch (e: any) {
    if (e?.status) return NextResponse.json(e.body, { status: e.status });
    console.error(e);
    return NextResponse.json(
      { error: "server_error", message: "Something went wrong updating the request" },
      { status: 500 }
    );
  }
}