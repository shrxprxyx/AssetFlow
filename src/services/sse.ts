import { subscribeToNotifications } from "@/services/realtime";

/** Server-Sent Events stream behind the notification bell. */

/** Open tabs allowed per user. A runaway client can't hold unlimited connections. */
export const MAX_STREAMS_PER_USER = 5;

const encoder = new TextEncoder();
const open = new Map<number, number>();

export const openStreamCount = (userId: number) => open.get(userId) ?? 0;

type StreamOptions = {
  /** How often an idle connection gets a comment line, so proxies don't drop it. */
  heartbeatMs?: number;
  /**
   * The stream ends after this long and the browser reconnects by itself. That
   * makes every connection re-check the session now and then.
   */
  maxLifetimeMs?: number;
};

/**
 * Returns a stream that writes `event: notification` each time the user gets
 * notifications (the browser then reloads its list), or null if the user
 * already has too many streams open.
 */
export function openNotificationStream(
  userId: number,
  signal: AbortSignal,
  { heartbeatMs = 25_000, maxLifetimeMs = 30 * 60_000 }: StreamOptions = {}
): ReadableStream<Uint8Array> | null {
  if (openStreamCount(userId) >= MAX_STREAMS_PER_USER) return null;
  open.set(userId, openStreamCount(userId) + 1);

  let cleanup = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };

      const unsubscribe = subscribeToNotifications(userId, () => write("event: notification\ndata: {}\n\n"));
      const heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
      const lifetime = setTimeout(() => cleanup(), maxLifetimeMs);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
        signal.removeEventListener("abort", cleanup);
        const left = openStreamCount(userId) - 1;
        if (left > 0) open.set(userId, left);
        else open.delete(userId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      if (signal.aborted) return cleanup();
      signal.addEventListener("abort", cleanup);
      write("retry: 5000\nevent: ready\ndata: {}\n\n");
    },
    cancel() {
      cleanup();
    },
  });
}
