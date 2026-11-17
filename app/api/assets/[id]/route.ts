import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireWriteAuth } from "@/lib/guards";
import { readJson, validationError } from "@/lib/http";
import { logActivity } from "@/lib/logActivity";
import { updateAsset } from "@/lib/assetLifecycle";

const badId = () =>
  NextResponse.json({ error: "invalid_id", message: "Invalid asset id" }, { status: 400 });

// "" from a form means "clear this field".
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

// Deliberately has NO .default() values and is built by hand (not .partial()
// of the create schema): a default inside an update schema would silently
// reset fields the caller never sent.
const assetUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "Asset name required").optional(),
    categoryId: z.coerce.number().int().positive().optional(),
    serialNumber: z.preprocess(blankToNull, z.string().nullable()).optional(),
    acquisitionDate: z.preprocess(blankToNull, z.coerce.date().nullable()).optional(),
    acquisitionCost: z.number().nonnegative().nullable().optional(),
    condition: z.enum(["GOOD", "FAIR", "POOR"]).optional(),
    location: z.preprocess(blankToNull, z.string().nullable()).optional(),
    isBookable: z.boolean().optional(),
    photoUrl: z.preprocess(blankToNull, z.string().nullable()).optional(),
    notes: z.preprocess(blankToNull, z.string().nullable()).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to change" });

// GET /api/assets/:id  -> one asset with its category and current holder
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return badId();

  const asset = await prisma.asset.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, name: true } },
      allocations: {
        where: { status: "ACTIVE" },
        take: 1,
        include: { holder: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  });
  if (!asset) {
    return NextResponse.json({ error: "not_found", message: "Asset not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...asset,
    currentHolder: asset.allocations[0]?.holder ?? null,
    allocations: undefined,
  });
}

// PATCH /api/assets/:id  -> edit details (status changes go through /status)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireWriteAuth("ADMIN", "ASSET_MANAGER");
  if (!guard.ok) return guard.response;

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return badId();

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = assetUpdateSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const asset = await updateAsset(id, parsed.data);
    try {
      await logActivity("asset_updated", {
        actorId: guard.user.userId,
        resourceType: "Asset",
        resourceId: id,
        changes: { fields: Object.keys(parsed.data) },
      });
    } catch (err) {
      console.error("activity log failed for asset_updated", err);
    }
    return NextResponse.json(asset);
  } catch (e: any) {
    if (e?.status && e?.body) return NextResponse.json(e.body, { status: e.status });
    console.error(e);
    return NextResponse.json({ error: "server_error", message: "Failed to update asset" }, { status: 500 });
  }
}