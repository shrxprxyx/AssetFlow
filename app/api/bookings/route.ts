import { NextRequest, NextResponse } from "next/server";
import { bookingSchema } from "@/lib/schemas";
import { createBooking, getBookingsForResource } from "@/lib/bookings";
import { logActivity } from "@/lib/logActivity";
import { requireAuth } from "@/lib/guards";

export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const resourceId = Number(searchParams.get("resourceId"));
  const dateParam = searchParams.get("date");

  if (!resourceId || !dateParam) {
    return NextResponse.json(
      { error: "validation_error", message: "resourceId and date are required", field: "resourceId" },
      { status: 400 }
    );
  }

  const bookings = await getBookingsForResource(resourceId, new Date(dateParam));
  return NextResponse.json({ bookings });
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const bookerId = guard.user.userId;

  const body = await req.json();
  const parsed = bookingSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: "validation_error", message: issue.message, field: issue.path[0] },
      { status: 400 }
    );
  }
  const { resourceId, startTime, endTime, purpose } = parsed.data;

  try {
    const booking = await createBooking(resourceId, bookerId, startTime, endTime, purpose);
    await logActivity("booking_confirmed", {
      actorId: bookerId,
      resourceType: "ResourceBooking",
      resourceId: booking.id,
    });
    return NextResponse.json({ booking }, { status: 201 });
  } catch (e: any) {
    // createBooking throws { status, body } for expected failures
    // (409 overlap, 404 unknown resource, 400 not bookable)
    if (e?.status && e?.body) return NextResponse.json(e.body, { status: e.status });
    console.error(e);
    return NextResponse.json({ error: "server_error", message: "Something went wrong creating the booking" }, { status: 500 });
  }
}
