import { prisma, Prisma } from '@/lib/prisma';
import { CreateAssetSchema } from '@/lib/schemas';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { AssetStatus } from '@prisma/client';

const VALID_ASSET_STATUSES = Object.values(AssetStatus);

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Only Admin or AssetManager can register assets
  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user || !['ADMIN', 'ASSET_MANAGER'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const data = CreateAssetSchema.parse(body);

    // Validate category exists
    const category = await prisma.assetCategory.findUnique({
      where: { id: data.categoryId },
    });
    if (!category) {
      return NextResponse.json({ error: 'Category not found' }, { status: 400 });
    }

    // Check serial number uniqueness if provided
    if (data.serialNumber) {
      const existing = await prisma.asset.findFirst({
        where: { serialNumber: data.serialNumber },
      });
      if (existing) {
        return NextResponse.json(
          { error: 'Asset with this serial number already exists' },
          { status: 400 }
        );
      }
    }

    // Generate asset tag: AF-NNNN, retried if a concurrent insert takes the same tag
    async function nextAssetTag() {
      const last = await prisma.asset.findFirst({
        orderBy: { assetTag: 'desc' },
        select: { assetTag: true },
      });
      const lastNum = last ? parseInt(last.assetTag.replace('AF-', ''), 10) : 0;
      return `AF-${String(lastNum + 1).padStart(4, '0')}`;
    }

    // Parse acquisition date if provided
    const acquisitionDate = data.acquisitionDate
      ? new Date(data.acquisitionDate)
      : null;

    let asset = null;
    for (let attempt = 0; attempt < 5 && !asset; attempt++) {
      const assetTag = await nextAssetTag();
      try {
        asset = await prisma.asset.create({
          data: {
            assetTag,
            name: data.name,
            categoryId: data.categoryId,
            serialNumber: data.serialNumber,
            acquisitionDate,
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
        // P2002 = unique constraint on assetTag; retry. Anything else is a real error.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
    if (!asset) {
      return NextResponse.json({ error: 'Could not generate a unique asset tag, please retry' }, { status: 409 });
    }

    return NextResponse.json(asset);
  } catch (error) {
    console.error('Error creating asset:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create asset' },
      { status: 400 }
    );
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const tag = searchParams.get('tag');
    const serial = searchParams.get('serial');
    const name = searchParams.get('name');
    const categoryId = searchParams.get('categoryId');
    const statusParam = searchParams.get('status');
    const location = searchParams.get('location');

    if (statusParam && !VALID_ASSET_STATUSES.includes(statusParam as AssetStatus)) {
      return NextResponse.json(
        { error: 'validation_error', message: `status must be one of ${VALID_ASSET_STATUSES.join(', ')}`, field: 'status' },
        { status: 400 }
      );
    }
    const status = statusParam as AssetStatus | null;

    const assets = await prisma.asset.findMany({
      where: {
        ...(tag && { assetTag: { contains: tag } }),
        ...(serial && { serialNumber: { contains: serial } }),
        ...(name && { name: { contains: name } }),
        ...(categoryId && { categoryId: parseInt(categoryId) }),
        ...(status && { status }),
        ...(location && { location: { contains: location } }),
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

    // Format response to flatten allocations
    const formatted = assets.map((asset: typeof assets[number]) => ({
      ...asset,
      currentHolder: asset.allocations[0]?.holder || null,
      allocations: undefined,
    }));

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Error fetching assets:', error);
    return NextResponse.json(
      { error: 'Failed to fetch assets' },
      { status: 500 }
    );
  }
}
