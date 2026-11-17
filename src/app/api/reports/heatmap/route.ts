import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/services/guards";
import { getBookingHeatmap } from "@/services/reports";
import { isValidTimeZone } from "@/utils/heatmap";

const ALLOWED_DAYS = [7, 30, 90];

// Booking heatmap: how busy bookable resources are by weekday and hour.
//   ?days=7|30|90   window of whole local days ending yesterday (default 30)
//   ?tz=Asia/Calcutta   zone the hours are read in (default UTC)
export async function GET(req: NextRequest) {
  const guard = await requireAuth("ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD");
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const days = Number(searchParams.get("days") ?? 30);
  if (!ALLOWED_DAYS.includes(days)) {
    return NextResponse.json(
      { error: "validation_error", message: `days must be one of ${ALLOWED_DAYS.join(", ")}`, field: "days" },
      { status: 400 }
    );
  }
  const timeZone = searchParams.get("tz") ?? "UTC";
  if (!isValidTimeZone(timeZone)) {
    return NextResponse.json(
      { error: "validation_error", message: "tz must be a valid time zone name, e.g. Asia/Calcutta", field: "tz" },
      { status: 400 }
    );
  }

  return NextResponse.json(await getBookingHeatmap({ days, timeZone }));
}
