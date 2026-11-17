/**
 * Background worker. Run it as its own process, next to the web app:
 *
 *     npm run worker          (or: npm run worker:dev  to restart on changes)
 *
 * It does two things:
 *   1. handles "who should be notified about this?" jobs that the web app queues,
 *      and sends the emails it queues (password reset links),
 *   2. runs the scheduled jobs: the overdue sweep (every 5 min) and the
 *      booking reminder / status tick (every minute).
 */
import { notifyForActivity } from "../lib/notifications";
import { sendMail } from "../lib/mailer";
import { runOverdueSweep, runBookingTick } from "../lib/sweeps";
import { prisma } from "../lib/prisma";
import { startWorkers } from "./runtime";

const log = (...args: unknown[]) => console.log(new Date().toISOString(), "[worker]", ...args);

async function main() {
  const workers = await startWorkers({
    handleEvent: ({ action, options }) => notifyForActivity(action, options),
    handleEmail: (email) => sendMail(email),
    sweeps: {
      "overdue-sweep": () => runOverdueSweep(),
      "booking-tick": () => runBookingTick(),
    },
  });

  // Catch up straight away: if the worker was down, don't wait for the next schedule.
  for (const [name, run] of [
    ["booking-tick", runBookingTick],
    ["overdue-sweep", runOverdueSweep],
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