import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { maintenanceRequestSchema } from "@/lib/schemas";
import { raiseMaintenanceRequest } from "@/lib/maintenance";
import { logActivity } from "@/lib/logActivity";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/guards";
import { readJson, validationError } from "@/lib/http";

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
  // Lost, retired and disposed assets are left out: they can't be maintained.
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
      where: { status: { notIn: ["LOST", "RETIRED", "DISPOSED"] } },
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

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = maintenanceRequestSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);
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