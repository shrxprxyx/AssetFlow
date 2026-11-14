import { NextRequest, NextResponse } from "next/server";
import { bookingSchema } from "@/lib/schemas";
import { createBooking, getBookingsForResource } from "@/lib/bookings";
import { logActivity } from "@/lib/logActivity";
import { requireAuth } from "@/lib/guards";
import { readJson, validationError } from "@/lib/http";

export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const resourceId = Number(searchParams.get("resourceId"));
  const dateParam = searchParams.get("date");

  if (!Number.isInteger(resourceId) || resourceId <= 0 || !dateParam) {
    return NextResponse.json(
      { error: "validation_error", message: "resourceId and date are required", field: "resourceId" },
      { status: 400 }
    );
  }

  const date = new Date(dateParam);
  if (Number.isNaN(date.getTime())) {
    return NextResponse.json(
      { error: "validation_error", message: "date must be a valid date, e.g. 2026-12-01", field: "date" },
      { status: 400 }
    );
  }

  const bookings = await getBookingsForResource(resourceId, date);
  return NextResponse.json({ bookings });
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const bookerId = guard.user.userId;

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = bookingSchema.safeParse(json.body);
  if (!parsed.success) return validationError(parsed.error);
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
    // (409 overlap / unavailable, 404 unknown resource, 400 not bookable or bad times)
    if (e?.status && e?.body) return NextResponse.json(e.body, { status: e.status });
    console.error(e);
    return NextResponse.json({ error: "server_error", message: "Something went wrong creating the booking" }, { status: 500 });
  }
}