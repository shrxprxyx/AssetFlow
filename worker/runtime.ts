import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { EVENTS_QUEUE, SWEEPS_QUEUE, redisUrl, type EventJobData } from "../lib/queue";

export type WorkerHandlers = {
  /** Turn one activity event into notifications. */
  handleEvent: (data: EventJobData) => Promise<void>;
  /** The scheduled jobs, by name. */
  sweeps: Record<string, () => Promise<unknown>>;
};

export type ScheduleConfig = Record<string, number>; // job name -> run every N ms

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  "overdue-sweep": 5 * 60_000,
  "booking-tick": 60_000,
};

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
      log(`${job.name} finished`, JSON.stringify(result ?? {}));
      return result;
    },
    { connection, concurrency: 1 } // never run two sweeps at once
  );

  for (const w of [eventWorker, sweepWorker]) {
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

  log(`started - listening on "${EVENTS_QUEUE}", scheduling: ${Object.keys(schedule).join(", ")}`);

  return {
    eventWorker,
    sweepWorker,
    async close() {
      await Promise.all([eventWorker.close(), sweepWorker.close()]);
      await sweepQueue.close();
      await connection.quit().catch(() => undefined);
    },
  };
}