import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset, createDepartment } from "./helpers/db";

// These are database-level guarantees: they hold no matter which code path writes.
describe("foreign keys", () => {
  beforeEach(resetDb);

  const rejects = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: "P2003" });

  it("asset history must name a real actor", async () => {
    const asset = await createAsset();
    await rejects(
      prisma.assetHistory.create({ data: { assetId: asset.id, toStatus: "AVAILABLE", actorId: 999999 } })
    );
  });

  it("a user who wrote asset history cannot be deleted", async () => {
    const actor = await createUser();
    const asset = await createAsset();
    await prisma.assetHistory.create({ data: { assetId: asset.id, toStatus: "AVAILABLE", actorId: actor.id } });

    await rejects(prisma.user.delete({ where: { id: actor.id } }));
  });

  it("a maintenance technician must be a real user and cannot be deleted while assigned", async () => {
    const asset = await createAsset();
    const requester = await createUser();
    const tech = await createUser({ role: "ASSET_MANAGER" });
    const base = { assetId: asset.id, requesterId: requester.id, description: "Broken screen" };

    await rejects(prisma.maintenanceRequest.create({ data: { ...base, technicianId: 999999 } }));
    await prisma.maintenanceRequest.create({ data: { ...base, technicianId: tech.id } });
    await rejects(prisma.user.delete({ where: { id: tech.id } }));
  });

  it("an owning department cannot be deleted while it owns assets", async () => {
    const dept = await createDepartment();
    const asset = await createAsset();
    await prisma.asset.update({ where: { id: asset.id }, data: { departmentId: dept.id } });

    await rejects(prisma.department.delete({ where: { id: dept.id } }));
  });

  it("an asset cannot point at a department that does not exist", async () => {
    const asset = await createAsset();
    await rejects(prisma.asset.update({ where: { id: asset.id }, data: { departmentId: 999999 } }));
  });

  it("deleting an activity event keeps its notifications, just unlinked", async () => {
    const user = await createUser();
    const log = await prisma.activityLog.create({ data: { action: "TEST" } });
    const note = await prisma.notification.create({
      data: { userId: user.id, type: "TEST", message: "hi", activityLogId: log.id },
    });

    await prisma.activityLog.delete({ where: { id: log.id } });

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: note.id } });
    expect(after.activityLogId).toBeNull();
  });

  it("a notification cannot point at an activity event that does not exist", async () => {
    const user = await createUser();
    await rejects(
      prisma.notification.create({
        data: { userId: user.id, type: "TEST", message: "hi", activityLogId: 999999 },
      })
    );
  });
});
