import { NextRequest, NextResponse } from "next/server";
import { listTransfers } from "@/lib/transfers";
import { requireAuth } from "@/lib/guards";

// GET /api/transfers?status=PENDING|ALL  (default ALL)
// Each role only sees the requests it's involved in or responsible for.
export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const status = new URL(req.url).searchParams.get("status") === "PENDING" ? "PENDING" : "ALL";
  const data = await listTransfers(guard.user, status);
  return NextResponse.json({ data, total: data.length });
}
