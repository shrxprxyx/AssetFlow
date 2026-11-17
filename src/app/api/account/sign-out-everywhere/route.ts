import { NextResponse } from "next/server";
import { prisma } from "@/services/prisma";
import { requireWriteAuth } from "@/services/guards";
import { recordActivity, dispatchActivity } from "@/services/outbox";

// POST /api/account/sign-out-everywhere
// Ends every session of the signed-in user, this one included. The caller
// should then sign out locally and go to the login page.
export async function POST() {
  const guard = await requireWriteAuth();
  if (!guard.ok) return guard.response;

  // The new session version and its audit entry commit together.
  const eventId = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: guard.user.userId }, data: { sessionVersion: { increment: 1 } } });
    return recordActivity(tx, "signed_out_everywhere", {
      actorId: guard.user.userId,
      resourceType: "User",
      resourceId: guard.user.userId,
    });
  });
  await dispatchActivity(eventId);

  return NextResponse.json({ ok: true });
}
