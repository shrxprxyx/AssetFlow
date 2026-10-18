import { prisma } from '@/lib/prisma';
import { CreateAllocationSchema } from '@/lib/schemas';
import { allocateAsset } from '@/lib/allocations';
import { logActivity } from '@/lib/logActivity';
import { requireAuth } from '@/lib/guards';
import { NextRequest, NextResponse } from 'next/server';
import { AllocationStatus, Prisma } from '@prisma/client';

const VALID_ALLOCATION_STATUSES = Object.values(AllocationStatus);

export async function POST(req: NextRequest) {
  // Spec: Asset Managers allocate; Department Heads approve/allocate within
  // their department. Employees can't hand assets out.
  const guard = await requireAuth('ADMIN', 'ASSET_MANAGER', 'DEPARTMENT_HEAD');
  if (!guard.ok) return guard.response;
  const actorId = guard.user.userId;

  try {
    const body = await req.json();
    const data = CreateAllocationSchema.parse(body);

    // Call core allocation logic (row lock + conflict detection + unique index)
    const result = await allocateAsset(
      data.assetId,
      data.holderId || null,
      data.holderDeptId || null,
      data.holderType,
      data.expectedReturnDate ? new Date(data.expectedReturnDate) : undefined,
      actorId
    );

    if (!result.success) {
      // Conflict detected - return 409 with conflict info
      if (result.currentlyHeldBy) {
        return NextResponse.json(
          {
            error: result.error,
            currently_held_by: result.currentlyHeldBy,
          },
          { status: 409 }
        );
      }
      // Other error
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await logActivity('asset_allocated', {
      actorId,
      resourceType: 'Asset',
      resourceId: data.assetId,
      changes: { holderId: data.holderId, holderDeptId: data.holderDeptId },
    });

    // Success
    return NextResponse.json(result.allocation, { status: 200 });
  } catch (error) {
    console.error('Error allocating asset:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to allocate asset' },
      { status: 400 }
    );
  }
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
