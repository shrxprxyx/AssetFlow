import { Queue } from "bullmq";
import IORedis from "ioredis";

export const EVENTS_QUEUE = "events";
export const SWEEPS_QUEUE = "sweeps";
export const EMAILS_QUEUE = "emails";

export type EmailJobData = { to: string; subject: string; text: string };

export type EventJobData = {
  action: string;
  options: {
    actorId?: number | null;
    resourceType?: string;
    resourceId?: number;
    changes?: Record<string, unknown>;
  };
};

export const redisUrl = () => process.env.REDIS_URL ?? "redis://localhost:6379";

/** How a failed job is retried: 5 attempts, waiting 2s, 4s, 8s, 16s between them. */
export const EVENT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 }, // kept so failed jobs can be inspected
};

/**
 * Emails are retried like events, but a finished job is deleted straight away:
 * a password-reset email contains the reset link, which shouldn't sit in Redis.
 */
export const EMAIL_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: { age: 3_600 }, // seconds; reset links are dead long before this
};

// One producer connection per process, kept across Next.js hot reloads.
const g = globalThis as unknown as {
  __eventsQueue?: Queue<EventJobData>;
  __producerRedis?: IORedis;
  __emailsQueue?: Queue<EmailJobData>;
  __emailsQueueRedis?: IORedis;
};

function producer() {
  if (!g.__eventsQueue || !g.__producerRedis) {
    // Web requests must never hang on a dead Redis: fail fast, no offline buffering.
    const connection = new IORedis(redisUrl(), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
    });
    connection.on("error", () => {
      /* reported by enqueueNotification when a job can't be queued */
    });
    g.__producerRedis = connection;
    g.__eventsQueue = new Queue<EventJobData>(EVENTS_QUEUE, {
      connection,
      defaultJobOptions: EVENT_JOB_OPTIONS,
    });
    // Without a listener BullMQ prints every connection error to the console.
    g.__eventsQueue.on("error", () => {
      /* reported by enqueueNotification when a job can't be queued */
    });
  }
  return { queue: g.__eventsQueue, connection: g.__producerRedis };
}

function waitUntilReady(connection: IORedis, ms: number): Promise<boolean> {
  if (connection.status === "ready") return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      connection.off("ready", onReady);
      resolve(ok);
    };
    const onReady = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    connection.once("ready", onReady);
  });
}

// Circuit breaker: after a failed attempt, don't even try Redis for a while, so a
// Redis outage costs each request nothing instead of a wait on every call.
const RETRY_REDIS_AFTER_MS = 10_000;
let redisDownUntil = 0;

/**
 * Puts a "work out who to notify" job on the queue.
 *
 * Returns true  -> the worker process will handle it.
 * Returns false -> it was NOT queued (inline mode, or Redis is down) and the
 *                  caller should do the work itself so nothing is lost.
 */
export async function enqueueNotification(
  action: string,
  options: EventJobData["options"]
): Promise<boolean> {
  if (process.env.QUEUE_MODE === "inline") return false;
  if (Date.now() < redisDownUntil) return false;

  try {
    const { queue, connection } = producer();
    if (!(await waitUntilReady(connection, 1_500))) {
      redisDownUntil = Date.now() + RETRY_REDIS_AFTER_MS;
      console.warn("[queue] Redis is not reachable - handling notifications inline for the next 10s");
      return false;
    }
    await queue.add(action, { action, options });
    return true;
  } catch (err) {
    redisDownUntil = Date.now() + RETRY_REDIS_AFTER_MS;
    console.warn("[queue] could not enqueue", action, "- handling inline instead:", (err as Error).message);
    return false;
  }
}

/** The emails queue shares the producer's Redis connection. */
function emailProducer() {
  const { connection } = producer();
  // If the producer connection was replaced, the old queue object is useless.
  if (!g.__emailsQueue || g.__emailsQueueRedis !== connection) {
    g.__emailsQueue = new Queue<EmailJobData>(EMAILS_QUEUE, {
      connection,
      defaultJobOptions: EMAIL_JOB_OPTIONS,
    });
    g.__emailsQueue.on("error", () => {
      /* reported by enqueueEmail when a job can't be queued */
    });
    g.__emailsQueueRedis = connection;
  }
  return { queue: g.__emailsQueue, connection };
}

/**
 * Puts a "send this email" job on the queue.
 *
 * Returns true  -> the worker process will send it.
 * Returns false -> it was NOT queued (inline mode, or Redis is down) and the
 *                  caller should send it itself.
 */
export async function enqueueEmail(email: EmailJobData): Promise<boolean> {
  if (process.env.QUEUE_MODE === "inline") return false;
  if (Date.now() < redisDownUntil) return false;

  try {
    const { queue, connection } = emailProducer();
    if (!(await waitUntilReady(connection, 1_500))) {
      redisDownUntil = Date.now() + RETRY_REDIS_AFTER_MS;
      console.warn("[queue] Redis is not reachable - sending email inline");
      return false;
    }
    await queue.add("send-email", email);
    return true;
  } catch (err) {
    redisDownUntil = Date.now() + RETRY_REDIS_AFTER_MS;
    console.warn("[queue] could not enqueue email - sending inline instead:", (err as Error).message);
    return false;
  }
}
