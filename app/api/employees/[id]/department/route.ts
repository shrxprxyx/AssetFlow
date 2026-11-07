import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/logActivity";
import { requireAuth } from "@/lib/guards";

// Body: { departmentId: number | null }. Admin only.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const guard = await requireAuth("ADMIN");
  if (!guard.ok) return guard.response;

  const employeeId = Number(id);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid employee id" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const departmentId = body?.departmentId;
  if (departmentId !== null && !(Number.isInteger(departmentId) && departmentId > 0)) {
    return NextResponse.json(
      { error: "validation_error", message: "departmentId must be a positive number or null", field: "departmentId" },
      { status: 400 }
    );
  }

  const target = await prisma.user.findUnique({ where: { id: employeeId } });
  if (!target) {
    return NextResponse.json({ error: "not_found", message: "Employee not found" }, { status: 404 });
  }

  if (departmentId !== null) {
    const dept = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!dept || dept.status !== "ACTIVE") {
      return NextResponse.json(
        { error: "invalid_department", message: "Department not found or inactive" },
        { status: 400 }
      );
    }
  }

  const updated = await prisma.user.update({
    where: { id: employeeId },
    data: { departmentId },
  });

  await logActivity("employee_department_changed", {
    actorId: guard.user.userId,
    resourceType: "User",
    resourceId: employeeId,
    changes: { from: target.departmentId, to: departmentId },
  });

  return NextResponse.json({ id: updated.id, departmentId: updated.departmentId });
}
