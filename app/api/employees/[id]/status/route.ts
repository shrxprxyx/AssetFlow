import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/logActivity";
import { requireAuth } from "@/lib/guards";

// Body: { status: "ACTIVE" | "INACTIVE" }. Admin only.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const guard = await requireAuth("ADMIN");
  if (!guard.ok) return guard.response;

  const employeeId = Number(id);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid employee id" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  if (body?.status !== "ACTIVE" && body?.status !== "INACTIVE") {
    return NextResponse.json(
      { error: "validation_error", message: "status must be ACTIVE or INACTIVE", field: "status" },
      { status: 400 }
    );
  }

  if (employeeId === guard.user.userId && body.status === "INACTIVE") {
    return NextResponse.json(
      { error: "self_change", message: "You can't deactivate your own account" },
      { status: 400 }
    );
  }

  const target = await prisma.user.findUnique({ where: { id: employeeId } });
  if (!target) {
    return NextResponse.json({ error: "not_found", message: "Employee not found" }, { status: 404 });
  }

  const updated = await prisma.user.update({
    where: { id: employeeId },
    data: { status: body.status },
  });

  await logActivity("employee_status_changed", {
    actorId: guard.user.userId,
    resourceType: "User",
    resourceId: employeeId,
    changes: { from: target.status, to: updated.status },
  });

  return NextResponse.json({ id: updated.id, status: updated.status });
}
