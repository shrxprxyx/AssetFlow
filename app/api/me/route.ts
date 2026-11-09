import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/guards";
import { prisma } from "@/lib/prisma";

// Returns the signed-in user's current role and status from the database.
// requireAuth returns 401 when the account is inactive or missing, which the
// protected layout uses to sign the user out.
export async function GET() {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const user = await prisma.user.findUnique({
    where: { id: guard.user.userId },
    select: { id: true, role: true, status: true, departmentId: true },
  });
  return NextResponse.json(user);
}
