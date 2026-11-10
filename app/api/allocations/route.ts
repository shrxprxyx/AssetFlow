import { prisma } from '@/lib/prisma';
import { CreateAllocationSchema } from '@/lib/schemas';
import { allocateAsset } from '@/lib/allocations';
import { logActivity } from '@/lib/logActivity';
import { requireAuth } from '@/lib/guards';
import { readJson, validationError } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { AllocationStatus, Prisma } from '@prisma/client';

const VALID_ALLOCATION_STATUSES = Object.values(AllocationStatus);

export async function POST(req: NextRequest) {
  // Spec: Asset Managers allocate; Department Heads approve/allocate within
  // their department. Employees can't hand assets out.
  const guard = await requireAuth('ADMIN', 'ASSET_MANAGER', 'DEPARTMENT_HEAD');
  if (!guard.ok) return guard.response;
  const actorId = guard.user.userId;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = CreateAllocationSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);
  const data = parsed.data;

  // The target must exist and be active; this also tells us which department it belongs to.
  let targetDeptId: number | null;
  if (data.holderType === 'EMPLOYEE') {
    const recipient = await prisma.user.findUnique({
      where: { id: data.holderId! },
      select: { status: true, departmentId: true },
    });
    if (!recipient || recipient.status !== 'ACTIVE') {
      return NextResponse.json(
        { error: 'invalid_recipient', message: 'Recipient not found or inactive', field: 'holderId' },
        { status: 400 }
      );
    }
    targetDeptId = recipient.departmentId;
  } else {
    const dept = await prisma.department.findUnique({
      where: { id: data.holderDeptId! },
      select: { status: true },
    });
    if (!dept || dept.status !== 'ACTIVE') {
      return NextResponse.json(
        { error: 'invalid_department', message: 'Department not found or inactive', field: 'holderDeptId' },
        { status: 400 }
      );
    }
    targetDeptId = data.holderDeptId!;
  }

  // A Department Head may only allocate inside their own department.
  if (guard.user.role === 'DEPARTMENT_HEAD') {
    if (guard.user.departmentId === null || targetDeptId !== guard.user.departmentId) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Department Heads can only allocate to people in their own department' },
        { status: 403 }
      );
    }
  }

  const result = await allocateAsset(
    data.assetId,
    data.holderType === 'EMPLOYEE' ? data.holderId! : null,
    data.holderType === 'DEPARTMENT' ? data.holderDeptId! : null,
    data.holderType,
    data.expectedReturnDate,
    actorId
  );

  if (!result.success) {
    if (result.currentlyHeldBy) {
      return NextResponse.json(
        {
          error: 'asset_already_allocated',
          message: 'This asset is already allocated',
          currentlyHeldBy: result.currentlyHeldBy,
          currently_held_by: result.currentlyHeldBy, // legacy key the current UI reads
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: result.error, message: result.error }, { status: 400 });
  }

  // The allocation is already committed; a logging failure must not report it as failed.
  try {
    await logActivity('asset_allocated', {
      actorId,
      resourceType: 'Asset',
      resourceId: data.assetId,
      changes: { holderId: data.holderId ?? null, holderDeptId: data.holderDeptId ?? null },
    });
  } catch (err) {
    console.error('activity log failed for asset_allocated', err);
  }

  return NextResponse.json(result.allocation, { status: 201 });
}

export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const { user } = guard;

  try {
    const { searchParams } = new URL(req.url);
    const assetId = searchParams.get('assetId');
    const holderId = searchParams.get('holderId');
    const statusParam = searchParams.get('status') || 'ACTIVE';

    if (!VALID_ALLOCATION_STATUSES.includes(statusParam as AllocationStatus)) {
      return NextResponse.json(
        { error: 'validation_error', message: `status must be one of ${VALID_ALLOCATION_STATUSES.join(', ')}`, field: 'status' },
        { status: 400 }
      );
    }
    const status = statusParam as AllocationStatus;

    // Visibility by role (matches the spec):
    //  - Employee: only what they hold
    //  - Department Head: their department's allocations
    //  - Admin / Asset Manager: everything
    let scope: Prisma.AllocationWhereInput = {};
    if (user.role === 'EMPLOYEE') {
      scope = { holderId: user.userId };
    } else if (user.role === 'DEPARTMENT_HEAD') {
      scope = user.departmentId
        ? {
            OR: [
              { holderDeptId: user.departmentId },
              { holder: { departmentId: user.departmentId } },
            ],
          }
        : { holderId: user.userId };
    }

    const allocations = await prisma.allocation.findMany({
      where: {
        ...scope,
        ...(assetId && { assetId: parseInt(assetId) }),
        ...(holderId && { holderId: parseInt(holderId) }),
        status,
      },
      include: {
        holder: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        asset: {
          select: {
            id: true,
            assetTag: true,
            name: true,
            status: true,
          },
        },
      },
      orderBy: { allocatedDate: 'desc' },
      take: 100,
    });

    return NextResponse.json(allocations);
  } catch (error) {
    console.error('Error fetching allocations:', error);
    return NextResponse.json(
      { error: 'Failed to fetch allocations' },
      { status: 500 }
    );
  }
}