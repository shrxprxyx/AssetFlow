import { describe, it, expect, beforeEach } from "vitest";
import { handleEventJob, recordActivity, relayPending } from "@/lib/outbox";
import { DEFAULT_SCHEDULE } from "../worker/runtime";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";

describe("outbox in the worker", () => {
  let admin: Awaited<ReturnType<typeof createUser>>;
  let holder: Awaited<ReturnType<typeof createUser>>;
  let options: NonNullable<Parameters<typeof recordActivity>[2]>;

  beforeEach(async () => {
    await resetDb();
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

  it("runs the relay every 5 seconds", () => {
    expect(DEFAULT_SCHEDULE["outbox-relay"]).toBe(5_000);
  });

  it("a job with an activityLogId processes that row", async () => {
    const id = await recordActivity(prisma, "asset_allocated", options);

    await handleEventJob({ action: "asset_allocated", options, activityLogId: id });

    expect((await prisma.activityLog.findUniqueOrThrow({ where: { id } })).processedAt).not.toBeNull();
    const notes = await prisma.notification.findMany();
    expect(notes.map((n) => [n.userId, n.activityLogId])).toEqual([[holder.id, id]]);
  });

  it("the job and the relay running for the same event notify once", async () => {
    const id = await recordActivity(prisma, "asset_allocated", options);

    await Promise.all([
      handleEventJob({ action: "asset_allocated", options, activityLogId: id }),
      relayPending({ minAgeMs: 0 }),
    ]);
    await handleEventJob({ action: "asset_allocated", options, activityLogId: id });

    expect(await prisma.notification.count()).toBe(1);
  });

  it("a job queued before the outbox existed (no activityLogId) still notifies", async () => {
    await handleEventJob({ action: "asset_allocated", options });
    expect(await prisma.notification.count()).toBe(1);
  });

  it("a job for a row that does not exist does nothing and does not throw", async () => {
    await expect(
      handleEventJob({ action: "asset_allocated", options, activityLogId: 999_999 })
    ).resolves.toBeUndefined();
    expect(await prisma.notification.count()).toBe(0);
  });
});
