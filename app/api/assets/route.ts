import { prisma, Prisma } from '@/lib/prisma';
import { CreateAssetSchema } from '@/lib/schemas';
import { NextRequest, NextResponse } from 'next/server';
import { AssetStatus } from '@prisma/client';
import { requireAuth } from '@/lib/guards';
import { readJson, validationError } from '@/lib/http';

const VALID_ASSET_STATUSES = Object.values(AssetStatus);
const ci = (v: string) => ({ contains: v, mode: 'insensitive' as const });

export async function POST(req: NextRequest) {
  const guard = await requireAuth('ADMIN', 'ASSET_MANAGER');
  if (!guard.ok) return guard.response;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = CreateAssetSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);
  const data = parsed.data;

  try {
    const category = await prisma.assetCategory.findUnique({ where: { id: data.categoryId } });
    if (!category) {
      return NextResponse.json(
        { error: 'validation_error', message: 'Category not found', field: 'categoryId' },
        { status: 400 }
      );
    }

    async function nextAssetTag() {
      const last = await prisma.asset.findFirst({
        orderBy: { assetTag: 'desc' },
        select: { assetTag: true },
      });
      const lastNum = last ? parseInt(last.assetTag.replace('AF-', ''), 10) : 0;
      return `AF-${String(lastNum + 1).padStart(4, '0')}`;
    }

    let asset = null;
    for (let attempt = 0; attempt < 5 && !asset; attempt++) {
      const assetTag = await nextAssetTag();
      try {
        asset = await prisma.asset.create({
          data: {
            assetTag,
            name: data.name,
            categoryId: data.categoryId,
            serialNumber: data.serialNumber || null,
            acquisitionDate: data.acquisitionDate ?? null,
            acquisitionCost: data.acquisitionCost,
            condition: data.condition,
            location: data.location,
            isBookable: data.isBookable,
            photoUrl: data.photoUrl,
            notes: data.notes,
            status: 'AVAILABLE',
          },
          include: { category: { select: { name: true } } },
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        // Unique violation: duplicate serial (real conflict) or a tag race (retry).
        if (String(e.meta?.target ?? '').includes('serialNumber')) {
          return NextResponse.json(
            { error: 'serial_taken', message: 'An asset with this serial number already exists', field: 'serialNumber' },
            { status: 409 }
          );
        }
      }
    }
    if (!asset) {
      return NextResponse.json(
        { error: 'tag_conflict', message: 'Could not generate a unique asset tag, please retry' },
        { status: 409 }
      );
    }

    return NextResponse.json(asset, { status: 201 });
  } catch (error) {
    console.error('Error creating asset:', error);
    return NextResponse.json(
      { error: 'server_error', message: 'Failed to create asset' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  try {
    const { searchParams } = new URL(req.url);
    const tag = searchParams.get('tag');
    const serial = searchParams.get('serial');
    const name = searchParams.get('name');
    const categoryParam = searchParams.get('categoryId');
    const statusParam = searchParams.get('status');
    const location = searchParams.get('location');

    if (statusParam && !VALID_ASSET_STATUSES.includes(statusParam as AssetStatus)) {
      return NextResponse.json(
        { error: 'validation_error', message: `status must be one of ${VALID_ASSET_STATUSES.join(', ')}`, field: 'status' },
        { status: 400 }
      );
    }
    const categoryId = categoryParam ? Number(categoryParam) : null;
    if (categoryParam && (!Number.isInteger(categoryId) || categoryId! <= 0)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'categoryId must be a positive integer', field: 'categoryId' },
        { status: 400 }
      );
    }

    const assets = await prisma.asset.findMany({
      where: {
        ...(tag && { assetTag: ci(tag) }),
        ...(serial && { serialNumber: ci(serial) }),
        ...(name && { name: ci(name) }),
        ...(categoryId && { categoryId }),
        ...(statusParam && { status: statusParam as AssetStatus }),
        ...(location && { location: ci(location) }),
      },
      include: {
        category: { select: { name: true } },
        allocations: {
          where: { status: 'ACTIVE' },
          take: 1,
          include: { holder: { select: { id: true, firstName: true, lastName: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const formatted = assets.map((asset: (typeof assets)[number]) => ({
      ...asset,
      currentHolder: asset.allocations[0]?.holder || null,
      allocations: undefined,
    }));

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Error fetching assets:', error);
    return NextResponse.json({ error: 'Failed to fetch assets' }, { status: 500 });
  }
}