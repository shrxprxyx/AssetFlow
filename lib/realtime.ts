import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { redisUrl } from "@/lib/queue";

/**
 * "This user has new notifications" messages, from whichever process created
 * them (a web request or the worker) to the web processes that hold the open
 * browser connections.
 *
 *   publishNotificationsCreated([userId])      <- notifications.ts, after saving them
 *   subscribeToNotifications(userId, callback) <- the SSE stream
 *
 * Messages carry only user ids, never notification text. Between processes they
 * travel over Redis pub/sub; inside one process they go straight to listeners.
 * If Redis is down, only listeners in the publishing process hear about it, and
 * the bell's slow background refresh still catches the rest.
 */

const CHANNEL = "assetflow:notifications";
const INSTANCE_ID = randomUUID();

type Wire = { from: string; userIds: number[] };

const g = globalThis as unknown as {
  __rtBus?: EventEmitter;
  __rtPublisher?: IORedis;
  __rtSubscriber?: IORedis;
};

function bus() {
  if (!g.__rtBus) {
    g.__rtBus = new EventEmitter();
    g.__rtBus.setMaxListeners(0); // one listener per open browser tab
  }
  return g.__rtBus;
}

const redisEnabled = () => process.env.QUEUE_MODE !== "inline" && process.env.RATE_LIMIT_STORE !== "memory";

const topic = (userId: number) => `user:${userId}`;

function emitLocal(userIds: number[]) {
  for (const id of new Set(userIds)) {
    // EventEmitter stops at the first listener that throws; call them one by one
    // so a broken tab can't silence the others.
    for (const listener of bus().listeners(topic(id))) {
      try {
        (listener as () => void)();
      } catch (err) {
        console.error("[realtime] listener failed:", (err as Error).message);
      }
    }
  }
}

function publisher() {
  if (!g.__rtPublisher) {
    g.__rtPublisher = new IORedis(redisUrl(), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
    });
    g.__rtPublisher.on("error", () => {
      /* publishing falls back to this process only */
    });
  }
  return g.__rtPublisher;
}

/** One Redis subscription per web process, started when the first tab connects. */
function ensureSubscriber() {
  if (g.__rtSubscriber || !redisEnabled()) return;
  const sub = new IORedis(redisUrl(), { maxRetriesPerRequest: null });
  sub.on("error", () => {
    /* ioredis reconnects and re-subscribes by itself */
  });
  sub.subscribe(CHANNEL).catch(() => undefined);
  sub.on("message", (_channel, raw) => {
    try {
      const msg = JSON.parse(raw) as Wire;
      // Our own messages were already delivered locally when they were published.
      if (msg.from === INSTANCE_ID || !Array.isArray(msg.userIds)) return;
      emitLocal(msg.userIds.filter((n) => Number.isInteger(n)));
    } catch {
      /* ignore malformed messages */
    }
  });
  g.__rtSubscriber = sub;
}

/** Call after notifications have been saved. Never throws. */
export async function publishNotificationsCreated(userIds: number[]): Promise<void> {
  if (userIds.length === 0) return;
  try {
    emitLocal(userIds);
    if (redisEnabled()) {
      const wire: Wire = { from: INSTANCE_ID, userIds: [...new Set(userIds)] };
      await publisher().publish(CHANNEL, JSON.stringify(wire));
    }
  } catch (err) {
    console.warn("[realtime] could not publish:", (err as Error).message);
  }
}

/** Runs `onNotified` whenever this user gets notifications. Returns an unsubscribe function. */
export function subscribeToNotifications(userId: number, onNotified: () => void): () => void {
  ensureSubscriber();
  bus().on(topic(userId), onNotified);
  return () => {
    bus().off(topic(userId), onNotified);
  };
}

/** For tests: drop every listener. */
export function resetRealtimeForTests() {
  bus().removeAllListeners();
}
