import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { maintenanceRequestSchema } from "@/lib/schemas";
import { raiseMaintenanceRequest } from "@/lib/maintenance";
import { logActivity } from "@/lib/logActivity";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/guards";

export async function GET() {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const { user } = guard;

  // Who sees which requests:
  //   Admin / Asset Manager : all of them
  //   Department Head       : their own + their department's
  //   Employee              : the ones they raised, or are assigned to as technician
  let where: Prisma.MaintenanceRequestWhereInput = {};
  if (user.role === "EMPLOYEE") {
    where = { OR: [{ requesterId: user.userId }, { technicianId: user.userId }] };
  } else if (user.role === "DEPARTMENT_HEAD") {
    where = user.departmentId
      ? {
          OR: [
            { requesterId: user.userId },
            { technicianId: user.userId },
            { requester: { departmentId: user.departmentId } },
          ],
        }
      : { OR: [{ requesterId: user.userId }, { technicianId: user.userId }] };
  }

  // Also returns a minimal asset picker list for the "raise request" form.
  // This intentionally does NOT create a general-purpose /api/assets route —
  // that's Person 2's Asset Registry endpoint. Swap this out for a call to
  // theirs once it lands; until then this keeps Maintenance self-contained.
  const [requests, assets] = await Promise.all([
    prisma.maintenanceRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        asset: { select: { assetTag: true, name: true } },
        requester: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.asset.findMany({
      where: { status: { notIn: ["LOST", "DISPOSED"] } },
      select: { id: true, assetTag: true, name: true, status: true },
      orderBy: { assetTag: "asc" },
    }),
  ]);

  return NextResponse.json({ data: requests, total: requests.length, assets });
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const requesterId = guard.user.userId;

  const body = await req.json();
  const parsed = maintenanceRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: "validation_error", message: issue.message, field: issue.path[0] },
      { status: 400 }
    );
  }
  const { assetId, description, priority } = parsed.data;

  try {
    const request = await raiseMaintenanceRequest(assetId, requesterId, description, priority);
    await logActivity("maintenance_raised", {
      actorId: requesterId,
      resourceType: "MaintenanceRequest",
      resourceId: request.id,
    });
    return NextResponse.json({ request }, { status: 201 });
  } catch (e: any) {
    if (e?.status) return NextResponse.json(e.body, { status: e.status });
    console.error(e);
    return NextResponse.json(
      { error: "server_error", message: "Something went wrong raising the request" },
      { status: 500 }
    );
  }
}
