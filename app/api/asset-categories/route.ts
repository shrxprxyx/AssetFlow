import { prisma, Prisma } from '@/lib/prisma';
import { CreateAssetCategorySchema, UpdateAssetCategorySchema } from '@/lib/schemas';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/guards';
import { readJson, validationError } from '@/lib/http';

const bad = (message: string, field?: string, status = 400) =>
  NextResponse.json({ error: 'validation_error', message, field }, { status });

const isDuplicate = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export async function POST(req: NextRequest) {
  const guard = await requireAuth('ADMIN', 'ASSET_MANAGER');
  if (!guard.ok) return guard.response;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = CreateAssetCategorySchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);
  const data = parsed.data;

  try {
    const category = await prisma.assetCategory.create({
      data: { name: data.name, description: data.description, customFields: data.customFields },
    });
    return NextResponse.json(category, { status: 201 });
  } catch (error) {
    if (isDuplicate(error)) {
      return NextResponse.json(
        { error: 'name_taken', message: 'A category with this name already exists', field: 'name' },
        { status: 409 }
      );
    }
    console.error('Error creating category:', error);
    return NextResponse.json({ error: 'server_error', message: 'Failed to create category' }, { status: 500 });
  }
}

export async function GET() {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  try {
    const categories = await prisma.assetCategory.findMany({ orderBy: { createdAt: 'desc' } });
    return NextResponse.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requireAuth('ADMIN', 'ASSET_MANAGER');
  if (!guard.ok) return guard.response;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const { id, ...rest } = (json.body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(id) || (id as number) <= 0) return bad('Category ID required', 'id');

  const parsed = UpdateAssetCategorySchema.safeParse(rest);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const category = await prisma.assetCategory.update({
      where: { id: id as number },
      data: parsed.data,
    });
    return NextResponse.json(category);
  } catch (error) {
    if (isDuplicate(error)) {
      return NextResponse.json(
        { error: 'name_taken', message: 'A category with this name already exists', field: 'name' },
        { status: 409 }
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return bad('Category not found', 'id', 404);
    }
    console.error('Error updating category:', error);
    return NextResponse.json({ error: 'server_error', message: 'Failed to update category' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAuth('ADMIN', 'ASSET_MANAGER');
  if (!guard.ok) return guard.response;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const id = (json.body as { id?: unknown } | null)?.id;
  if (!Number.isInteger(id) || (id as number) <= 0) return bad('Category ID required', 'id');

  try {
    const inUse = await prisma.asset.findFirst({ where: { categoryId: id as number } });
    if (inUse) return bad('Category is in use by assets. Cannot delete.');

    await prisma.assetCategory.delete({ where: { id: id as number } });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return bad('Category not found', 'id', 404);
    }
    console.error('Error deleting category:', error);
    return NextResponse.json({ error: 'server_error', message: 'Failed to delete category' }, { status: 500 });
  }
}