import { prisma } from '@/lib/prisma';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/guards';
import { Role, UserStatus } from '@prisma/client';

const VALID_ROLES = Object.values(Role);
const VALID_STATUSES = Object.values(UserStatus);

// Employee directory.
//   Admin / Asset Manager : everyone
//   Department Head       : only their own department
//   Employee              : not allowed (this list exposes emails and roles)
export async function GET(req: NextRequest) {
  const guard = await requireAuth('ADMIN', 'ASSET_MANAGER', 'DEPARTMENT_HEAD');
  if (!guard.ok) return guard.response;
  const { user } = guard;

  try {
    const { searchParams } = new URL(req.url);
    const departmentId = searchParams.get('departmentId');
    const roleParam = searchParams.get('role');
    const statusParam = searchParams.get('status');

    // Query params arrive as plain strings - Prisma's `where` expects the
    // real Role/UserStatus enums, so validate + narrow instead of casting
    // blindly (a bad ?role=foo should 400, not crash Prisma or silently
    // return unfiltered results).
    if (roleParam && !VALID_ROLES.includes(roleParam as Role)) {
      return NextResponse.json(
        { error: 'validation_error', message: `role must be one of ${VALID_ROLES.join(', ')}`, field: 'role' },
        { status: 400 }
      );
    }
    if (statusParam && !VALID_STATUSES.includes(statusParam as UserStatus)) {
      return NextResponse.json(
        { error: 'validation_error', message: `status must be one of ${VALID_STATUSES.join(', ')}`, field: 'status' },
        { status: 400 }
      );
    }

    const role = roleParam as Role | null;
    const status = statusParam as UserStatus | null;

    // A Department Head is pinned to their own department no matter what the
    // query string says.
    let departmentFilter: number | undefined = departmentId ? parseInt(departmentId) : undefined;
    if (user.role === 'DEPARTMENT_HEAD') {
      if (user.departmentId === null) return NextResponse.json([]);
      departmentFilter = user.departmentId;
    }

    const employees = await prisma.user.findMany({
      where: {
        ...(departmentFilter !== undefined && { departmentId: departmentFilter }),
        ...(role && { role }),
        ...(status && { status }),
      },
      include: {
        department: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Format response
    const formatted = employees.map((emp: typeof employees[number]) => ({
      id: emp.id,
      firstName: emp.firstName,
      lastName: emp.lastName,
      email: emp.email,
      departmentId: emp.departmentId,
      departmentName: emp.department?.name,
      role: emp.role,
      status: emp.status,
    }));

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Error fetching employees:', error);
    return NextResponse.json(
      { error: 'Failed to fetch employees' },
      { status: 500 }
    );
  }
}
