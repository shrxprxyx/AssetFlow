import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/services/guards";
import { openNotificationStream } from "@/services/sse";

// Streams must never be cached or pre-rendered, and need the Node runtime
// (Redis and long-lived responses don't work on the edge).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/notifications/stream
// Server-Sent Events. Sends `event: notification` whenever the signed-in user
// gets new notifications; the browser then reloads GET /api/notifications.
// The events carry no notification text, so the list stays the single source
// of truth (and the user's access rules stay in one place).
export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const stream = openNotificationStream(guard.user.userId, req.signal);
  if (!stream) {
    return NextResponse.json(
      { error: "too_many_streams", message: "Too many open connections. Close another tab and try again." },
      { status: 429, headers: { "Retry-After": "30" } }
    );
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tell nginx and similar proxies not to hold the stream back in a buffer.
      "X-Accel-Buffering": "no",
    },
  });
}
