import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/services/prisma";
import { resetDb, createUser } from "./helpers/db";

describe("outbox schema", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a new activity row is unprocessed with zero attempts", async () => {
    const row = await prisma.activityLog.create({ data: { action: "x" } });
    expect(row.processedAt).toBeNull();
    expect(row.processAttempts).toBe(0);
  });

  it("the same event, user and type is stored once even when inserted twice", async () => {
    const user = await createUser();
    const log = await prisma.activityLog.create({ data: { action: "x" } });
    const data = [{ userId: user.id, type: "x", message: "hi", activityLogId: log.id }];

    await prisma.notification.createMany({ data, skipDuplicates: true });
    await prisma.notification.createMany({ data, skipDuplicates: true });

    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);
  });

  it("notifications without an event can repeat", async () => {
    const user = await createUser();
    const data = { userId: user.id, type: "overdue", message: "late" };
    await prisma.notification.create({ data });
    await prisma.notification.create({ data });
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(2);
  });
});
