import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWriteAuth } from "@/lib/guards";
import { logActivity } from "@/lib/logActivity";

// POST /api/account/sign-out-everywhere
// Ends every session of the signed-in user, this one included. The caller
// should then sign out locally and go to the login page.
export async function POST() {
  const guard = await requireWriteAuth();
  if (!guard.ok) return guard.response;

  await prisma.user.update({ where: { id: guard.user.userId }, data: { sessionVersion: { increment: 1 } } });

  try {
    await logActivity("signed_out_everywhere", {
      actorId: guard.user.userId,
      resourceType: "User",
      resourceId: guard.user.userId,
    });
  } catch (err) {
    console.error("activity log failed for signed_out_everywhere", err);
  }

  return NextResponse.json({ ok: true });
}
