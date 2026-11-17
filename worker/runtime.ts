import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import {
  EVENTS_QUEUE,
  SWEEPS_QUEUE,
  EMAILS_QUEUE,
  redisUrl,
  type EventJobData,
  type EmailJobData,
} from "../src/lib/queue";

export type WorkerHandlers = {
  /** Turn one activity event into notifications. */
  handleEvent: (data: EventJobData) => Promise<void>;
  /** The scheduled jobs, by name. */
  sweeps: Record<string, () => Promise<unknown>>;
  /** Send one queued email. Optional: without it, no email worker is started. */
  handleEmail?: (data: EmailJobData) => Promise<void>;
};

export type ScheduleConfig = Record<string, number>; // job name -> run every N ms

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  "overdue-sweep": 5 * 60_000,
  "booking-tick": 60_000,
  // Safety net for events nothing else delivered (see lib/outbox.ts).
  "outbox-relay": 5_000,
};

const isIdleRelay = (name: string, result: unknown) =>
  name === "outbox-relay" &&
  (result as { processed?: number; failed?: number } | undefined)?.processed === 0 &&
  (result as { failed?: number }).failed === 0;

const log = (...args: unknown[]) => console.log(new Date().toISOString(), "[worker]", ...args);

/**
 * Starts the event worker and the scheduled-job worker.
 * Kept free of database imports so it can be tested with fake handlers.
 */
export async function startWorkers(
  handlers: WorkerHandlers,
  schedule: ScheduleConfig = DEFAULT_SCHEDULE,
  opts: { concurrency?: number } = {}
) {
  // Workers need blocking Redis commands that wait forever, so no retry cap.
  const connection = new IORedis(redisUrl(), { maxRetriesPerRequest: null });

  const eventWorker = new Worker<EventJobData>(
    EVENTS_QUEUE,
    async (job: Job<EventJobData>) => handlers.handleEvent(job.data),
    { connection, concurrency: opts.concurrency ?? 5 }
  );

  const sweepWorker = new Worker(
    SWEEPS_QUEUE,
    async (job: Job) => {
      const run = handlers.sweeps[job.name];
      if (!run) throw new Error(`Unknown scheduled job "${job.name}"`);
      const result = await run();
      // The relay runs every 5 s and usually finds nothing: stay quiet then.
      if (!isIdleRelay(job.name, result)) log(`${job.name} finished`, JSON.stringify(result ?? {}));
      return result;
    },
    { connection, concurrency: 1 } // never run two sweeps at once
  );

  const handleEmail = handlers.handleEmail;
  const emailWorker = handleEmail
    ? new Worker<EmailJobData>(
        EMAILS_QUEUE,
        async (job: Job<EmailJobData>) => handleEmail(job.data),
        { connection, concurrency: 2 }
      )
    : null;

  const workers: Worker[] = [eventWorker, sweepWorker, ...(emailWorker ? [emailWorker] : [])];

  for (const w of workers) {
    w.on("failed", (job, err) =>
      log(`job ${job?.name} (#${job?.id}) failed, attempt ${job?.attemptsMade}:`, err.message)
    );
    w.on("error", (err) => log("worker error:", err.message));
  }

  // Repeatable jobs. upsert makes restarting the worker safe: it never creates duplicates.
  const sweepQueue = new Queue(SWEEPS_QUEUE, { connection });
  for (const [name, every] of Object.entries(schedule)) {
    await sweepQueue.upsertJobScheduler(name, { every }, { name });
  }

  const queues = emailWorker ? `"${EVENTS_QUEUE}" and "${EMAILS_QUEUE}"` : `"${EVENTS_QUEUE}"`;
  log(`started - listening on ${queues}, scheduling: ${Object.keys(schedule).join(", ")}`);

  return {
    eventWorker,
    sweepWorker,
    emailWorker,
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await sweepQueue.close();
      await connection.quit().catch(() => undefined);
    },
  };
}