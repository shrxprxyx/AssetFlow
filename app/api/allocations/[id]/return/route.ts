import { prisma } from '@/lib/prisma';
import { ReturnAssetSchema } from '@/lib/schemas';
import { returnAsset } from '@/lib/allocations';
import { logActivity } from '@/lib/logActivity';
import { requireAuth } from '@/lib/guards';
import { NextRequest, NextResponse } from 'next/server';

// Mark an allocation returned + capture the condition check-in.
// Allowed for: the holder, Admin/Asset Manager, or the Department Head of the
// department that holds the asset.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const { user } = guard;

  const allocationId = Number(id);
  if (!Number.isInteger(allocationId) || allocationId <= 0) {
    return NextResponse.json({ error: 'invalid_id', message: 'Invalid allocation id' }, { status: 400 });
  }

  try {
    const existing = await prisma.allocation.findUnique({
      where: { id: allocationId },
      select: { holderId: true, holderDeptId: true, holder: { select: { departmentId: true } } },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Allocation not found' }, { status: 404 });
    }

    const isManager = user.role === 'ADMIN' || user.role === 'ASSET_MANAGER';
    const isHolder = existing.holderId === user.userId;
    const isDeptHeadOfHolder =
      user.role === 'DEPARTMENT_HEAD' &&
      user.departmentId !== null &&
      (existing.holderDeptId === user.departmentId ||
        existing.holder?.departmentId === user.departmentId);

    if (!isManager && !isHolder && !isDeptHeadOfHolder) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Only the holder or a manager can return this asset' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const data = ReturnAssetSchema.parse(body);

    const result = await returnAsset(allocationId, data.condition, data.returnNotes, user.userId);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await logActivity('asset_returned', {
      actorId: user.userId,
      resourceType: 'Allocation',
      resourceId: allocationId,
      changes: { condition: data.condition },
    });

    return NextResponse.json(
      { success: true, allocation: result.allocation },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error returning asset:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to return asset' },
      { status: 400 }
    );
  }
}
