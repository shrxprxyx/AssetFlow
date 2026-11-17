/**
 * Background worker. Run it as its own process, next to the web app:
 *
 *     npm run worker          (or: npm run worker:dev  to restart on changes)
 *
 * It does two things:
 *   1. handles "who should be notified about this?" jobs that the web app queues,
 *      and sends the emails it queues (password reset links),
 *   2. runs the scheduled jobs: the overdue sweep (every 5 min), the
 *      booking reminder / status tick (every minute) and the outbox relay
 *      (every 5 s), which delivers events that never reached the queue.
 */
import { handleEventJob, relayPending } from "../src/services/outbox";
import { sendMail } from "../src/services/mailer";
import { runOverdueSweep, runBookingTick } from "../src/services/sweeps";
import { prisma } from "../src/services/prisma";
import { startWorkers } from "./runtime";

const log = (...args: unknown[]) => console.log(new Date().toISOString(), "[worker]", ...args);

async function main() {
  const workers = await startWorkers({
    handleEvent: handleEventJob,
    handleEmail: (email) => sendMail(email),
    sweeps: {
      "overdue-sweep": () => runOverdueSweep(),
      "booking-tick": () => runBookingTick(),
      "outbox-relay": () => relayPending(),
    },
  });

  // Catch up straight away: if the worker was down, don't wait for the next schedule.
  for (const [name, run] of [
    ["booking-tick", runBookingTick],
    ["overdue-sweep", runOverdueSweep],
    // At startup there is no fast path to wait for: deliver everything pending now.
    ["outbox-relay", () => relayPending({ minAgeMs: 0 })],
  ] as const) {
    try {
      log(`startup ${name}:`, JSON.stringify(await run()));
    } catch (err) {
      log(`startup ${name} failed:`, (err as Error).message);
    }
  }

  const shutdown = async (signal: string) => {
    log(`${signal} received, finishing current jobs...`);
    await workers.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});