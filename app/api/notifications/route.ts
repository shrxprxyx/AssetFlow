import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/guards";

export async function GET() {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const userId = guard.user.userId;

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, type: true, message: true, isRead: true, createdAt: true },
    }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);

  return NextResponse.json({ notifications, unreadCount });
}

// Body: { ids?: number[] }. Omit ids to mark everything read.
export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const userId = guard.user.userId;

  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body?.ids) ? body.ids.filter((n: unknown) => Number.isInteger(n)) : null;

  await prisma.notification.updateMany({
    where: { userId, isRead: false, ...(ids ? { id: { in: ids } } : {}) },
    data: { isRead: true, readAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
