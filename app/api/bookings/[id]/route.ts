import { NextRequest, NextResponse } from "next/server";
import { cancelBookingAs } from "@/lib/bookings";
import { logActivity } from "@/lib/logActivity";
import { requireAuth } from "@/lib/guards";

// DELETE /api/bookings/:id  -> cancels the booking (it stays in the table as CANCELLED)
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const { user } = guard;

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid booking id" }, { status: 400 });
  }

  try {
    const booking = await cancelBookingAs(user, id);
    await logActivity("booking_cancelled", {
      actorId: user.userId,
      resourceType: "ResourceBooking",
      resourceId: id,
    });
    return NextResponse.json({ booking });
  } catch (e: any) {
    if (e?.status && e?.body) return NextResponse.json(e.body, { status: e.status });
    console.error(e);
    return NextResponse.json(
      { error: "server_error", message: "Something went wrong cancelling the booking" },
      { status: 500 }
    );
  }
}