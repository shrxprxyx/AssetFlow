import { prisma } from '@/lib/prisma';
import { CreateDepartmentSchema, UpdateDepartmentSchema } from '@/lib/schemas';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/guards';
import { readJson, validationError } from '@/lib/http';

const bad = (message: string, field?: string, status = 400) =>
  NextResponse.json({ error: 'validation_error', message, field }, { status });

const headSelect = { select: { id: true, firstName: true, lastName: true } };

// Walks up from `parentId`; true if `id` appears in the chain (would create a loop).
async function wouldCreateCycle(id: number, parentId: number) {
  const seen = new Set<number>();
  let cur: number | null = parentId;
  while (cur !== null && !seen.has(cur)) {
    if (cur === id) return true;
    seen.add(cur);
    const row: { parentDeptId: number | null } | null = await prisma.department.findUnique({
      where: { id: cur },
      select: { parentDeptId: true },
    });
    cur = row?.parentDeptId ?? null;
  }
  return false;
}

async function checkRefs(parentDeptId?: number | null, headId?: number | null) {
  if (parentDeptId) {
    const parent = await prisma.department.findUnique({ where: { id: parentDeptId } });
    if (!parent) return bad('Parent department not found', 'parentDeptId');
  }
  if (headId) {
    const head = await prisma.user.findUnique({ where: { id: headId } });
    if (!head || head.status !== 'ACTIVE') return bad('Head user not found or inactive', 'headId');
  }
  return null;
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth('ADMIN');
  if (!guard.ok) return guard.response;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = CreateDepartmentSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);
  const data = parsed.data;

  try {
    const refError = await checkRefs(data.parentDeptId, data.headId);
    if (refError) return refError;

    const dept = await prisma.department.create({
      data: {
        name: data.name,
        description: data.description,
        headId: data.headId,
        parentDeptId: data.parentDeptId,
        status: data.status,
      },
      include: { head: headSelect },
    });
    return NextResponse.json(dept, { status: 201 });
  } catch (error) {
    console.error('Error creating department:', error);
    return NextResponse.json({ error: 'server_error', message: 'Failed to create department' }, { status: 500 });
  }
}

export async function GET() {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  try {
    const depts = await prisma.department.findMany({
      include: { head: headSelect },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(depts);
  } catch (error) {
    console.error('Error fetching departments:', error);
    return NextResponse.json({ error: 'Failed to fetch departments' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requireAuth('ADMIN');
  if (!guard.ok) return guard.response;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const { id, ...rest } = (json.body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(id) || (id as number) <= 0) return bad('Department ID required', 'id');
  const deptId = id as number;

  const parsed = UpdateDepartmentSchema.safeParse(rest);
  if (!parsed.success) return validationError(parsed.error);
  const validated = parsed.data;

  try {
    const existing = await prisma.department.findUnique({ where: { id: deptId } });
    if (!existing) return bad('Department not found', 'id', 404);

    if (validated.parentDeptId) {
      if (await wouldCreateCycle(deptId, validated.parentDeptId)) {
        return bad('A department cannot be its own ancestor', 'parentDeptId');
      }
    }
    const refError = await checkRefs(validated.parentDeptId, validated.headId);
    if (refError) return refError;

    const dept = await prisma.department.update({
      where: { id: deptId },
      data: validated,
      include: { head: headSelect },
    });
    return NextResponse.json(dept);
  } catch (error) {
    console.error('Error updating department:', error);
    return NextResponse.json({ error: 'server_error', message: 'Failed to update department' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAuth('ADMIN');
  if (!guard.ok) return guard.response;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const id = (json.body as { id?: unknown } | null)?.id;
  if (!Number.isInteger(id) || (id as number) <= 0) return bad('Department ID required', 'id');
  const deptId = id as number;

  try {
    const [hasChildren, hasEmployees] = await Promise.all([
      prisma.department.findFirst({ where: { parentDeptId: deptId, status: 'ACTIVE' } }),
      prisma.user.findFirst({ where: { departmentId: deptId, status: 'ACTIVE' } }),
    ]);
    if (hasChildren || hasEmployees) {
      return bad('Cannot deactivate a department that still has active child departments or employees');
    }

    // Soft delete: set status to INACTIVE
    const dept = await prisma.department.update({ where: { id: deptId }, data: { status: 'INACTIVE' } });
    return NextResponse.json({ success: true, dept });
  } catch (error) {
    console.error('Error deleting department:', error);
    return NextResponse.json({ error: 'server_error', message: 'Failed to delete department' }, { status: 500 });
  }
}