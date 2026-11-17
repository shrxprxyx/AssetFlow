import { NextRequest } from "next/server";
import { listTransfers } from "@/lib/transfers";
import { requireAuth } from "@/lib/guards";
import { parsePagination, paginated } from "@/lib/pagination";

// GET /api/transfers?status=PENDING|ALL&page=1&pageSize=25  (status defaults to ALL)
// Each role only sees the requests it's involved in or responsible for.
export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const paging = parsePagination(searchParams);
  if (!paging.ok) return paging.response;

  const status = searchParams.get("status") === "PENDING" ? "PENDING" : "ALL";
  const { data, total } = await listTransfers(guard.user, status, paging.page);
  return paginated(data, total, paging.page);
}
