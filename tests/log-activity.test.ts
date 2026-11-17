import { describe, it, expect, beforeEach, vi } from "vitest";

// Replace the queue so we can decide whether "Redis" works.
vi.mock("@/services/queue", () => ({ enqueueNotification: vi.fn() }));

import { enqueueNotification } from "@/services/queue";
import { logActivity } from "@/services/logActivity";
import { prisma } from "@/services/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";

const queue = vi.mocked(enqueueNotification);

describe("logActivity and the queue", () => {
  let admin: Awaited<ReturnType<typeof createUser>>;
  let holder: Awaited<ReturnType<typeof createUser>>;
  let options: Parameters<typeof logActivity>[1];

  beforeEach(async () => {
    await resetDb();
    queue.mockReset();
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

  it("when queued, writes the audit entry but leaves the notification to the worker", async () => {
    queue.mockResolvedValue(true);

    await logActivity("asset_allocated", options);

    expect(queue).toHaveBeenCalledWith("asset_allocated", options, expect.any(Number));
    expect(await prisma.activityLog.count({ where: { action: "asset_allocated" } })).toBe(1);
    expect(await prisma.notification.count()).toBe(0);
  });

  it("when it can't be queued, creates the notification itself so nothing is lost", async () => {
    queue.mockResolvedValue(false);

    await logActivity("asset_allocated", options);

    expect(await prisma.activityLog.count({ where: { action: "asset_allocated" } })).toBe(1);
    const notes = await prisma.notification.findMany();
    expect(notes.map((n) => n.userId)).toEqual([holder.id]);
  });

  it("falls back inline when the queue throws, and never breaks the caller", async () => {
    queue.mockRejectedValue(new Error("redis exploded"));

    await expect(logActivity("asset_allocated", options)).resolves.toBeUndefined();

    expect(await prisma.activityLog.count({ where: { action: "asset_allocated" } })).toBe(1);
    expect(await prisma.notification.count()).toBe(1);
  });
});