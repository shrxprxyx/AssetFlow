import { NextRequest, NextResponse } from "next/server";
import { promoteSchema } from "@/lib/schemas";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/logActivity";
import { requireAuth } from "@/lib/guards";

// Changes an employee's role (promote or demote). Admin only.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Role is read from the database, not the login token, so a demoted admin
  // loses this power immediately instead of when their token expires.
  const guard = await requireAuth("ADMIN");
  if (!guard.ok) return guard.response;

  const employeeId = Number(id);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid employee id" }, { status: 400 });
  }

  const body = await req.json();
  const parsed = promoteSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: "validation_error", message: issue.message, field: issue.path[0] },
      { status: 400 }
    );
  }

  if (employeeId === guard.user.userId) {
    return NextResponse.json({ error: "self_change", message: "You can't change your own role" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id: employeeId } });
  if (!target) {
    return NextResponse.json({ error: "not_found", message: "Employee not found" }, { status: 404 });
  }
  if (target.role === "ADMIN") {
    return NextResponse.json({ error: "admin_target", message: "Admin roles can't be changed here" }, { status: 400 });
  }

  const updated = await prisma.user.update({
    where: { id: employeeId },
    data: { role: parsed.data.role },
  });

  await logActivity("role_changed", {
    actorId: guard.user.userId,
    resourceType: "User",
    resourceId: employeeId,
    changes: { from: target.role, to: updated.role },
  });

  return NextResponse.json({ id: updated.id, role: updated.role });
}
