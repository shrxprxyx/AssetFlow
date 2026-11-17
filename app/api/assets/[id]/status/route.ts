import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAuth } from "@/lib/guards";
import { readJson, validationError } from "@/lib/http";
import { logActivity } from "@/lib/logActivity";
import { changeAssetStatus } from "@/lib/assetLifecycle";

const statusSchema = z.object({
  // ALLOCATED and UNDER_MAINTENANCE are managed by the allocation and
  // maintenance workflows, so they can't be chosen here.
  status: z.enum(["AVAILABLE", "LOST", "RETIRED", "DISPOSED"]),
  reason: z.string().max(500).optional(),
});

async function safeLog(action: string, opts: Parameters<typeof logActivity>[1]) {
  try {
    await logActivity(action, opts);
  } catch (err) {
    console.error(`activity log failed for ${action}`, err);
  }
}

// POST /api/assets/:id/status  { status: "LOST" | "RETIRED" | "DISPOSED" | "AVAILABLE", reason? }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireWriteAuth("ADMIN", "ASSET_MANAGER");
  if (!guard.ok) return guard.response;
  const actorId = guard.user.userId;

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid asset id" }, { status: 400 });
  }

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = statusSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);
  const { status, reason } = parsed.data;

  try {
    const result = await changeAssetStatus(id, status, actorId, reason);

    await safeLog("asset_status_changed", {
      actorId,
      resourceType: "Asset",
      resourceId: id,
      changes: { from: result.from, to: result.asset.status, reason: reason ?? null },
    });
    // Tell the people whose bookings were cancelled (the notification skips the actor).
    for (const bookingId of result.cancelledBookingIds) {
      await safeLog("booking_cancelled", {
        actorId,
        resourceType: "ResourceBooking",
        resourceId: bookingId,
      });
    }

    return NextResponse.json({
      asset: result.asset,
      cancelledBookings: result.cancelledBookingIds.length,
    });
  } catch (e: any) {
    if (e?.status && e?.body) return NextResponse.json(e.body, { status: e.status });
    console.error(e);
    return NextResponse.json({ error: "server_error", message: "Failed to change asset status" }, { status: 500 });
  }
}