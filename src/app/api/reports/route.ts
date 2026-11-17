import { NextResponse } from "next/server";
import { getReportsSummary } from "@/services/reports";
import { requireAuth } from "@/services/guards";

export async function GET() {
  // Org-wide analytics: managers only (spec: "Give managers actionable insight").
  const guard = await requireAuth("ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD");
  if (!guard.ok) return guard.response;

  const data = await getReportsSummary();
  return NextResponse.json(data);
}
