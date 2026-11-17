import { describe, it, expect, beforeEach, vi } from "vitest";

// Wraps the real notification code in spies, so a test can make it fail once
// and everything else still runs against the real thing.
vi.mock("@/services/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/notifications")>();
  return { ...actual, createNotificationsFor: vi.fn(actual.createNotificationsFor) };
});
vi.mock("@/services/realtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/realtime")>();
  return { ...actual, publishNotificationsCreated: vi.fn(actual.publishNotificationsCreated) };
});

import { createNotificationsFor } from "@/services/notifications";
import { publishNotificationsCreated } from "@/services/realtime";
import {
  recordActivity,
  processActivityLog,
  dispatchActivity,
  relayPending,
  MAX_PROCESS_ATTEMPTS,
} from "@/services/outbox";
import { logActivity } from "@/services/logActivity";
import { prisma } from "@/services/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";

const notify = vi.mocked(createNotificationsFor);
const publish = vi.mocked(publishNotificationsCreated);

describe("outbox", () => {
  let admin: Awaited<ReturnType<typeof createUser>>;
  let holder: Awaited<ReturnType<typeof createUser>>;
  let options: Parameters<typeof recordActivity>[2];

  /** An "asset allocated" event: its notification goes to `holder`. */
  const record = () => recordActivity(prisma, "asset_allocated", options);
  const row = (id: number) => prisma.activityLog.findUniqueOrThrow({ where: { id } });
  const notificationCount = () => prisma.notification.count();

  beforeEach(async () => {
    await resetDb();
    notify.mockReset(); // back to the real implementation
    publish.mockClear();
    admin = await createUser({ role: "ADMIN" });
    holder = await createUser();
    const asset = await createAsset();
    options = {
      actorId: admin.id,
      resourceType: "Asset",
      resourceId: asset.id,
      changes: { holderId: holder.id },
    };
  });

  describe("recordActivity", () => {
    it("inside a rolled-back transaction leaves no row", async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await recordActivity(tx, "asset_allocated", options);
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      expect(await prisma.activityLog.count()).toBe(0);
    });

    it("inside a committed transaction writes an unprocessed row and returns its id", async () => {
      const id = await prisma.$transaction((tx) => recordActivity(tx, "asset_allocated", options));
      const saved = await row(id);
      expect(saved.action).toBe("asset_allocated");
      expect(saved.processedAt).toBeNull();
      expect(JSON.parse(saved.changes!)).toEqual({ holderId: holder.id });
    });
  });

  describe("processActivityLog", () => {
    it("creates the notifications once and marks the row processed", async () => {
      const id = await record();

      expect(await processActivityLog(id)).toBe("processed");

      const notes = await prisma.notification.findMany();
      expect(notes.map((n) => n.userId)).toEqual([holder.id]);
      expect(notes[0].activityLogId).toBe(id);
      expect((await row(id)).processedAt).not.toBeNull();
    });

    it("processing the same row twice does not duplicate notifications", async () => {
      const id = await record();
      await processActivityLog(id);
      expect(await processActivityLog(id)).toBe("skipped");
      expect(await notificationCount()).toBe(1);
    });

    it("a call that overlaps one already working on the row skips it", async () => {
      const id = await record();
      const real = notify.getMockImplementation()!;
      // Hold the first call inside its transaction (row locked) until we say go.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      notify.mockImplementationOnce(async (...args) => {
        await gate;
        return real(...args);
      });

      const first = processActivityLog(id);
      while (notify.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 5));

      expect(await processActivityLog(id)).toBe("skipped"); // returns at once, does not wait
      release();
      expect(await first).toBe("processed");
      expect(await notificationCount()).toBe(1);
    });

    it("a row whose handler throws stays unprocessed, counts the attempt and notifies nobody", async () => {
      const id = await record();
      notify.mockRejectedValueOnce(new Error("mail server on fire"));

      expect(await processActivityLog(id)).toBe("failed");

      const saved = await row(id);
      expect(saved.processedAt).toBeNull();
      expect(saved.processAttempts).toBe(1);
      expect(await notificationCount()).toBe(0);

      // and a later attempt can still succeed
      expect(await processActivityLog(id)).toBe("processed");
      expect(await notificationCount()).toBe(1);
    });

    it("does the work on the transaction connection, not the global client", async () => {
      const id = await record();
      await processActivityLog(id);
      // A second connection per event could exhaust the pool when many run at once.
      expect(notify.mock.calls[0][0]).not.toBe(prisma);
    });

    it("a database hiccup (pool timeout) does not use up an attempt", async () => {
      const id = await record();
      notify.mockRejectedValueOnce(Object.assign(new Error("pool timeout"), { code: "P2024" }));

      expect(await processActivityLog(id)).toBe("failed");

      expect((await row(id)).processAttempts).toBe(0);
      expect(await processActivityLog(id)).toBe("processed");
    });

    it("tells open browser tabs once, after the commit, and not for a repeat or a failure", async () => {
      const id = await record();
      notify.mockRejectedValueOnce(new Error("boom"));
      await processActivityLog(id); // fails
      expect(publish).not.toHaveBeenCalled();

      await processActivityLog(id); // succeeds
      await processActivityLog(id); // already done
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith([holder.id]);
    });

    it("gives up on a row after the attempt limit", async () => {
      const id = await record();
      await prisma.activityLog.update({ where: { id }, data: { processAttempts: MAX_PROCESS_ATTEMPTS } });

      expect(await processActivityLog(id)).toBe("skipped");
      expect(await notificationCount()).toBe(0);
    });

    it("answers skipped for an id that does not exist", async () => {
      expect(await processActivityLog(999_999)).toBe("skipped");
    });
  });

  describe("relayPending", () => {
    it("leaves young rows to the fast path and delivers older ones", async () => {
      const id = await record();

      expect(await relayPending({ minAgeMs: 60_000 })).toEqual({ processed: 0, failed: 0 });
      expect((await row(id)).processedAt).toBeNull();

      expect(await relayPending({ minAgeMs: 0 })).toEqual({ processed: 1, failed: 0 });
      expect((await row(id)).processedAt).not.toBeNull();
      expect(await notificationCount()).toBe(1);
    });

    it("recovers an event that was committed but never dispatched (crash after commit)", async () => {
      // The change and its event committed, then the process died before dispatchActivity().
      await prisma.$transaction((tx) => recordActivity(tx, "asset_allocated", options));
      expect(await notificationCount()).toBe(0);

      await relayPending({ minAgeMs: 0 });

      expect(await notificationCount()).toBe(1);
    });

    it("continues after one failing row", async () => {
      const [a, b, c] = [await record(), await record(), await record()];
      const real = notify.getMockImplementation()!;
      notify.mockImplementationOnce(real);
      notify.mockRejectedValueOnce(new Error("poison"));

      expect(await relayPending({ minAgeMs: 0 })).toEqual({ processed: 2, failed: 1 });

      expect((await row(a)).processedAt).not.toBeNull();
      expect((await row(b)).processedAt).toBeNull();
      expect((await row(c)).processedAt).not.toBeNull();
      // and the two that worked really notified (the failing one did not)
      expect(await notificationCount()).toBe(2);
    });

    it("stops retrying an event that keeps failing", async () => {
      const id = await record();
      notify.mockRejectedValue(new Error("always broken"));

      for (let i = 0; i < MAX_PROCESS_ATTEMPTS + 2; i++) await relayPending({ minAgeMs: 0 });

      expect(notify).toHaveBeenCalledTimes(MAX_PROCESS_ATTEMPTS);
      expect((await row(id)).processAttempts).toBe(MAX_PROCESS_ATTEMPTS);
    });

    it("honours the batch limit, oldest first", async () => {
      const first = await record();
      const second = await record();

      await relayPending({ minAgeMs: 0, limit: 1 });

      expect((await row(first)).processedAt).not.toBeNull();
      expect((await row(second)).processedAt).toBeNull();
    });

    it("does not notify people about history already marked processed", async () => {
      const id = await record();
      await prisma.activityLog.update({ where: { id }, data: { processedAt: new Date() } });

      expect(await relayPending({ minAgeMs: 0 })).toEqual({ processed: 0, failed: 0 });
      expect(await notificationCount()).toBe(0);
    });
  });

  describe("dispatchActivity and logActivity", () => {
    it("inline mode: dispatchActivity creates the notifications straight away", async () => {
      const id = await record();
      await dispatchActivity(id);
      expect(await notificationCount()).toBe(1);
      expect((await row(id)).processedAt).not.toBeNull();
    });

    it("logActivity writes the row, notifies, and marks it processed", async () => {
      await logActivity("asset_allocated", options);

      const saved = await prisma.activityLog.findFirstOrThrow();
      expect(saved.processedAt).not.toBeNull();
      expect(await notificationCount()).toBe(1);
    });

    it("logActivity never throws when the notification code fails, and the relay delivers later", async () => {
      notify.mockRejectedValueOnce(new Error("boom"));

      await expect(logActivity("asset_allocated", options)).resolves.toBeUndefined();

      const saved = await prisma.activityLog.findFirstOrThrow();
      expect(saved.processedAt).toBeNull();
      expect(await notificationCount()).toBe(0);

      await relayPending({ minAgeMs: 0 });
      expect(await notificationCount()).toBe(1);
    });
  });
});
