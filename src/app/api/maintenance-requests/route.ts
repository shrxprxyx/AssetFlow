import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { maintenanceRequestSchema } from "@/utils/schemas";
import { raiseMaintenanceRequest } from "@/services/maintenance";
import { prisma } from "@/services/prisma";
import { requireAuth, requireWriteAuth } from "@/services/guards";
import { readJson, validationError } from "@/utils/http";
import { parsePagination, paginated } from "@/utils/pagination";

// GET /api/maintenance-requests?page=1&pageSize=25
export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const { user } = guard;

  const paging = parsePagination(new URL(req.url).searchParams);
  if (!paging.ok) return paging.response;
  const { skip, take } = paging.page;

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

  const [requests, total] = await Promise.all([
    prisma.maintenanceRequest.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take,
      include: {
        asset: { select: { assetTag: true, name: true } },
        requester: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.maintenanceRequest.count({ where }),
  ]);

  return paginated(requests, total, paging.page);
}

export async function POST(req: NextRequest) {
  const guard = await requireWriteAuth();
  if (!guard.ok) return guard.response;
  const requesterId = guard.user.userId;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = maintenanceRequestSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);
  const { assetId, description, priority, photoUrl } = parsed.data;

  try {
    // The event is recorded with the request (see services/outbox.ts).
    const request = await raiseMaintenanceRequest(assetId, requesterId, description, priority, photoUrl, (r) => ({
      action: "maintenance_raised",
      actorId: requesterId,
      resourceType: "MaintenanceRequest",
      resourceId: r.id,
    }));
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