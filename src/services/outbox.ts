import { prisma, Prisma } from "@/services/prisma";
import { createNotificationsFor, notifyForActivity } from "@/services/notifications";
import { publishNotificationsCreated } from "@/services/realtime";
import { enqueueNotification, type EventJobData } from "@/services/queue";

/**
 * The outbox: ActivityLog doubles as the list of events that still have to be
 * turned into notifications.
 *
 *   recordActivity(db, ...)   writes the event. Pass a transaction client and
 *                             the event is committed together with the change
 *                             it describes, or not at all.
 *   dispatchActivity(id)      the fast path, called after the commit: hand the
 *                             event to the worker queue, or handle it here.
 *   processActivityLog(id)    does the work, safe to run twice and from several
 *                             processes at once.
 *   relayPending()            the safety net: delivers events that nothing else
 *                             did (a crash after commit, Redis down, a failed job).
 */

export type Db = Prisma.TransactionClient | typeof prisma;

export type ActivityInput = {
  actorId?: number | null;
  resourceType?: string;
  resourceId?: number;
  changes?: Record<string, unknown>;
};

/** An event to record: the action name plus the usual options. */
export type ActivitySpec = { action: string } & ActivityInput;

/** Either a fixed spec, or one built from the result of the work (when the ids only exist afterwards). */
export type ActivityFor<R> = ActivitySpec | ((result: R) => ActivitySpec);

export const MAX_PROCESS_ATTEMPTS = 5;
const DEFAULT_RELAY_LIMIT = 50;
const DEFAULT_RELAY_MIN_AGE_MS = 5_000;

export type ProcessResult = "processed" | "skipped" | "failed";

/** Writes the event and returns its id. Throws if it can't be written. */
export async function recordActivity(
  db: Db,
  action: string,
  options: ActivityInput = {}
): Promise<number> {
  const row = await db.activityLog.create({
    data: {
      actorId: options.actorId ?? null,
      action,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      changes: options.changes ? JSON.stringify(options.changes) : null,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * For code that wants its event committed together with its own work:
 *
 *   const eventId = await recordFor(tx, activity, result);   // inside the transaction
 *   ...commit...
 *   if (eventId) await dispatchActivity(eventId);             // after it
 *
 * Does nothing (returns undefined) when no activity was asked for.
 */
export async function recordFor<R>(
  db: Db,
  activity: ActivityFor<R> | undefined,
  result: R
): Promise<number | undefined> {
  if (!activity) return undefined;
  const spec = typeof activity === "function" ? activity(result) : activity;
  return recordActivity(db, spec.action, spec);
}

function parseChanges(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

type ClaimedRow = {
  id: number;
  action: string;
  actorId: number | null;
  resourceType: string | null;
  resourceId: number | null;
  changes: string | null;
};

const optionsOf = (row: ClaimedRow): ActivityInput => ({
  actorId: row.actorId,
  resourceType: row.resourceType ?? undefined,
  resourceId: row.resourceId ?? undefined,
  changes: parseChanges(row.changes),
});

/**
 * Creates the notifications for one event and marks it processed.
 *
 *  "processed"  this call did the work
 *  "skipped"    already done, already being done by someone else, or given up on
 *  "failed"     the work threw; the attempt is counted and the event stays unprocessed
 *
 * Never throws.
 */
export async function processActivityLog(id: number): Promise<ProcessResult> {
  let notified: number[] = [];
  let result: ProcessResult;
  try {
    result = await prisma.$transaction(
      async (tx) => {
        // SKIP LOCKED: if another process holds this row we move on instead of
        // waiting, so the same event is never worked on twice at the same time.
        const rows = await tx.$queryRaw<ClaimedRow[]>`
          SELECT id, action, "actorId", "resourceType", "resourceId", changes
          FROM "ActivityLog"
          WHERE id = ${id}
            AND "processedAt" IS NULL
            AND "processAttempts" < ${MAX_PROCESS_ATTEMPTS}
          FOR UPDATE SKIP LOCKED
        `;
        const row = rows[0];
        if (!row) return "skipped" as const;

        // Everything runs on `tx`: one connection per event (a second one per
        // claim could exhaust the pool when several events run at once), and the
        // notifications and processedAt commit together. Notifications are
        // inserted with skipDuplicates against a unique key (event, user, type),
        // so a retry after a crash can't notify twice.
        notified = await createNotificationsFor(tx, row.action, {
          ...optionsOf(row),
          activityLogId: row.id,
        });
        await tx.activityLog.update({ where: { id }, data: { processedAt: new Date() } });
        return "processed" as const;
      },
      { timeout: 15_000 }
    );
  } catch (err) {
    console.error("[outbox] could not process activity", id, err);
    // The transaction rolled back. Count the failed attempt, unless the failure
    // says nothing about this event (database unreachable, pool busy): a short
    // outage must not use up an event's retries.
    if (!isTransientDbError(err)) {
      await prisma.activityLog
        .updateMany({ where: { id, processedAt: null }, data: { processAttempts: { increment: 1 } } })
        .catch(() => {});
    }
    return "failed";
  }

  // Only now that the rows are committed can open browser tabs reload them.
  if (result === "processed") await publishNotificationsCreated(notified); // never throws
  return result;
}

// Prisma codes for "couldn't reach or start", not "this event is broken":
// P1001/P1002/P1017 cannot reach / lost the database, P2024 pool timeout,
// P2028 transaction could not start or timed out.
const TRANSIENT_DB_CODES = new Set(["P1001", "P1002", "P1017", "P2024", "P2028"]);

function isTransientDbError(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && TRANSIENT_DB_CODES.has(code);
}

/**
 * Called after the event's transaction has committed. Tries the worker queue
 * first; if that isn't available (inline mode, Redis down) it does the work
 * here. Never throws: whatever goes wrong, relayPending() delivers it later.
 */
export async function dispatchActivity(id: number): Promise<void> {
  try {
    const row = await prisma.activityLog.findUnique({
      where: { id },
      select: { action: true, actorId: true, resourceType: true, resourceId: true, changes: true },
    });
    if (!row) return;
    const queued = await enqueueNotification(
      row.action,
      optionsOf({ id, ...row }),
      id
    );
    if (queued) return;
  } catch (err) {
    console.error("[outbox] could not queue activity", id, err);
  }
  await processActivityLog(id);
}

/** Delivers events that are still unprocessed. Oldest first. */
export async function relayPending(
  opts: { limit?: number; minAgeMs?: number } = {}
): Promise<{ processed: number; failed: number }> {
  const limit = opts.limit ?? DEFAULT_RELAY_LIMIT;
  const minAgeMs = opts.minAgeMs ?? DEFAULT_RELAY_MIN_AGE_MS;

  // Young rows are left alone so the fast path (dispatchActivity) gets first go.
  const rows = await prisma.activityLog.findMany({
    where: {
      processedAt: null,
      processAttempts: { lt: MAX_PROCESS_ATTEMPTS },
      timestamp: { lte: new Date(Date.now() - minAgeMs) },
    },
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true },
  });

  let processed = 0;
  let failed = 0;
  // One at a time, and one bad event must not stop the rest.
  for (const { id } of rows) {
    const result = await processActivityLog(id);
    if (result === "processed") processed++;
    else if (result === "failed") failed++;
  }
  return { processed, failed };
}

/**
 * What the worker does with an "events" queue job. It does not throw when the
 * work fails: processActivityLog() has counted the attempt and relayPending()
 * retries it, so letting BullMQ retry as well would only double up.
 */
export async function handleEventJob(data: EventJobData): Promise<void> {
  if (data.activityLogId) {
    await processActivityLog(data.activityLogId);
    return;
  }
  // A job queued before the outbox existed: no row to track, just notify.
  await notifyForActivity(data.action, data.options);
}
