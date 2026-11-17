import { prisma } from '@/lib/prisma';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/guards';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { parsePagination, paginated } from '@/lib/pagination';

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
    // Search by name or email. Every word must match somewhere, so "priya sh" finds Priya Sharma.
    const words = (searchParams.get('q') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5);

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

    const paging = parsePagination(searchParams);
    if (!paging.ok) return paging.response;
    const { skip, take } = paging.page;

    const role = roleParam as Role | null;
    const status = statusParam as UserStatus | null;

    // A Department Head is pinned to their own department no matter what the
    // query string says.
    let departmentFilter: number | undefined = departmentId ? parseInt(departmentId) : undefined;
    if (user.role === 'DEPARTMENT_HEAD') {
      if (user.departmentId === null) return paginated([], 0, paging.page);
      departmentFilter = user.departmentId;
    }

    const where: Prisma.UserWhereInput = {
      ...(departmentFilter !== undefined && { departmentId: departmentFilter }),
      ...(role && { role }),
      ...(status && { status }),
      ...(words.length > 0 && {
        AND: words.map((w) => ({
          OR: [
            { firstName: { contains: w, mode: 'insensitive' as const } },
            { lastName: { contains: w, mode: 'insensitive' as const } },
            { email: { contains: w, mode: 'insensitive' as const } },
          ],
        })),
      }),
    };

    const [employees, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: {
          department: {
            select: { id: true, name: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      prisma.user.count({ where }),
    ]);

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

    return paginated(formatted, total, paging.page);
  } catch (error) {
    console.error('Error fetching employees:', error);
    return NextResponse.json(
      { error: 'Failed to fetch employees' },
      { status: 500 }
    );
  }
}
