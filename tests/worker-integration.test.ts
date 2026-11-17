import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import IORedis from "ioredis";
import { startWorkers } from "../worker/runtime";
import { handleEventJob } from "@/services/outbox";
import { runOverdueSweep } from "@/services/sweeps";
import { prisma } from "@/services/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";

// These tests use the REAL queue (Redis) and the REAL worker code.
// They use Redis database 15, so they can never touch the jobs of a worker you
// are running for development (which uses database 0).
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";

async function redisAvailable() {
  const probe = new IORedis(REDIS_URL, {
    lazyConnect: true,
    retryStrategy: () => null,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
  });
  probe.on("error", () => undefined); // an unreachable Redis is an expected answer here
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

// Without Redis these tests are skipped (not failed), so `npm test` still works anywhere.
const redisUp = await redisAvailable();

// The queue producer keeps its connection on globalThis; forget it between tests.
const g = globalThis as unknown as {
  __eventsQueue?: { close(): Promise<void> };
  __producerRedis?: { disconnect(): void };
};
async function resetProducer() {
  await g.__eventsQueue?.close().catch(() => undefined);
  g.__producerRedis?.disconnect();
  g.__eventsQueue = undefined;
  g.__producerRedis = undefined;
}

/** A fresh copy of logActivity (and the queue module behind it) pointed at `url`. */
async function freshLogActivity(url: string) {
  await resetProducer();
  vi.resetModules();
  process.env.REDIS_URL = url;
  return (await import("@/services/logActivity")).logActivity;
}

const startRealWorker = (schedule: Record<string, number> = {}) =>
  startWorkers(
    {
      handleEvent: handleEventJob,
      sweeps: { "overdue-sweep": () => runOverdueSweep() },
    },
    schedule
  );

describe.skipIf(!redisUp)("background worker (real Redis)", () => {
  let worker: Awaited<ReturnType<typeof startRealWorker>> | undefined;
  const originalMode = process.env.QUEUE_MODE;
  const originalUrl = process.env.REDIS_URL;

  beforeAll(() => {
    process.env.QUEUE_MODE = ""; // the other test files run inline; these must not
  });
  afterAll(() => {
    process.env.QUEUE_MODE = originalMode;
    if (originalUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalUrl;
  });

  beforeEach(async () => {
    await resetDb();
    const redis = new IORedis(REDIS_URL);
    await redis.flushdb();
    redis.disconnect();
    await resetProducer();
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await resetProducer();
  });

  it("hands the notification to the worker instead of creating it during the request", async () => {
    const [admin, holder] = await Promise.all([createUser({ role: "ADMIN" }), createUser()]);
    const asset = await createAsset();
    const logActivity = await freshLogActivity(REDIS_URL);

    await logActivity("asset_allocated", {
      actorId: admin.id,
      resourceType: "Asset",
      resourceId: asset.id,
      changes: { holderId: holder.id },
    });

    // The request is over: the audit entry exists, but nobody has been notified yet.
    expect(await prisma.activityLog.count({ where: { action: "asset_allocated" } })).toBe(1);
    expect(await prisma.notification.count()).toBe(0);

    // Start the worker afterwards: it finds the job waiting in Redis and handles it.
    worker = await startRealWorker();
    await vi.waitFor(
      async () => expect(await prisma.notification.count()).toBe(1),
      { timeout: 8_000, interval: 100 }
    );
    const [note] = await prisma.notification.findMany();
    expect(note.userId).toBe(holder.id);
    expect(note.type).toBe("asset_allocated");
  });

  it("still creates the notification (inline) when Redis is unreachable", async () => {
    const [admin, holder] = await Promise.all([createUser({ role: "ADMIN" }), createUser()]);
    const asset = await createAsset();
    const logActivity = await freshLogActivity("redis://localhost:6390/0"); // nothing listens here

    const started = Date.now();
    await logActivity("asset_allocated", {
      actorId: admin.id,
      resourceType: "Asset",
      resourceId: asset.id,
      changes: { holderId: holder.id },
    });

    expect(await prisma.notification.count()).toBe(1);
    expect((await prisma.notification.findFirstOrThrow()).userId).toBe(holder.id);
    expect(Date.now() - started).toBeLessThan(5_000); // it didn't hang waiting for Redis
  });

  it("runs the scheduled overdue sweep and flags each allocation only once", async () => {
    const manager = await createUser({ role: "ASSET_MANAGER" });
    const holder = await createUser();
    const asset = await createAsset({ status: "ALLOCATED" });
    await prisma.allocation.create({
      data: {
        assetId: asset.id,
        holderId: holder.id,
        holderType: "EMPLOYEE",
        status: "ACTIVE",
        expectedReturnDate: new Date(Date.now() - 24 * 3_600_000),
      },
    });
    // The sweep (running inside the worker) reports through the same queue,
    // exactly like in production, so point it at the test Redis.
    await freshLogActivity(REDIS_URL);

    worker = await startRealWorker({ "overdue-sweep": 300 }); // every 0.3s instead of every 5 min

    // holder + manager are told...
    await vi.waitFor(
      async () => {
        const who = (await prisma.notification.findMany({ where: { type: "allocation_overdue" } })).map((n) => n.userId);
        expect(who.sort()).toEqual([holder.id, manager.id].sort());
      },
      { timeout: 10_000, interval: 100 }
    );

    // ...and several more sweeps later, nobody is told again.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await prisma.notification.count({ where: { type: "allocation_overdue" } })).toBe(2);
    expect(await prisma.activityLog.count({ where: { action: "allocation_overdue" } })).toBe(1);
  });
});