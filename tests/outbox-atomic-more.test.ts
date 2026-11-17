import { describe, it, expect, beforeEach } from "vitest";
import { rejectTransfer, cancelTransfer } from "@/services/transfers";
import {
  approveMaintenanceRequest,
  rejectMaintenanceRequest,
  assignTechnician,
  startMaintenanceRequest,
} from "@/services/maintenance";
import { prisma } from "@/services/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";

// The same guarantee as outbox-atomic.test.ts, for the actions that used to write
// their audit entry after committing: the change and its event commit together,
// or neither does.

type User = Awaited<ReturnType<typeof createUser>>;
const actorOf = (u: User) => ({ userId: u.id, role: u.role, departmentId: u.departmentId });
const events = (action: string) => prisma.activityLog.findMany({ where: { action } });
const boom = () => {
  throw new Error("cannot record");
};

describe("transfer reject and cancel", () => {
  let admin: User;
  let requester: User;
  let requestId: number;

  beforeEach(async () => {
    await resetDb();
    admin = await createUser({ role: "ADMIN" });
    requester = await createUser();
    const asset = await createAsset();
    const to = await createUser();
    requestId = (
      await prisma.transferRequest.create({
        data: { assetId: asset.id, requestedBy: requester.id, toHolderId: to.id, status: "PENDING" },
      })
    ).id;
  });

  const status = async () => (await prisma.transferRequest.findUniqueOrThrow({ where: { id: requestId } })).status;
  const spec = (action: string) => ({ action, actorId: admin.id, resourceType: "TransferRequest", resourceId: requestId });

  it("reject records its event with the change", async () => {
    await rejectTransfer(actorOf(admin), requestId, spec("transfer_rejected"));

    expect(await status()).toBe("REJECTED");
    expect(await events("transfer_rejected")).toHaveLength(1);
  });

  it("reject rolls back when the event can't be recorded", async () => {
    await expect(rejectTransfer(actorOf(admin), requestId, boom as never)).rejects.toThrow();

    expect(await status()).toBe("PENDING");
  });

  it("cancel records its event with the change", async () => {
    await cancelTransfer(actorOf(requester), requestId, spec("transfer_cancelled"));

    expect(await status()).toBe("CANCELLED");
    expect(await events("transfer_cancelled")).toHaveLength(1);
  });

  it("cancel rolls back when the event can't be recorded", async () => {
    await expect(cancelTransfer(actorOf(requester), requestId, boom as never)).rejects.toThrow();

    expect(await status()).toBe("PENDING");
  });

  it("a request that was already decided records no event", async () => {
    await rejectTransfer(actorOf(admin), requestId, spec("transfer_rejected"));

    await expect(
      cancelTransfer(actorOf(requester), requestId, spec("transfer_cancelled"))
    ).rejects.toMatchObject({ status: 409 });
    expect(await events("transfer_cancelled")).toHaveLength(0);
  });
});

describe("maintenance reject, assign and start", () => {
  let manager: User;
  let tech: User;
  let requestId: number;

  beforeEach(async () => {
    await resetDb();
    manager = await createUser({ role: "ASSET_MANAGER" });
    tech = await createUser();
    const asset = await createAsset();
    requestId = (
      await prisma.maintenanceRequest.create({
        data: { assetId: asset.id, requesterId: tech.id, description: "Screen is cracked", priority: "LOW" },
      })
    ).id;
  });

  const row = () => prisma.maintenanceRequest.findUniqueOrThrow({ where: { id: requestId } });
  const spec = (action: string) => ({ action, actorId: manager.id, resourceType: "MaintenanceRequest", resourceId: requestId });
  const approve = () => approveMaintenanceRequest(requestId, manager.id);

  it("reject records its event, or rolls back if it can't", async () => {
    await expect(rejectMaintenanceRequest(requestId, manager.id, boom as never)).rejects.toThrow();
    expect((await row()).status).toBe("PENDING");

    await rejectMaintenanceRequest(requestId, manager.id, spec("maintenance_rejected"));
    expect((await row()).status).toBe("REJECTED");
    expect(await events("maintenance_rejected")).toHaveLength(1);
  });

  it("assign records its event, or rolls back if it can't", async () => {
    await approve();

    await expect(assignTechnician(requestId, tech.id, boom as never)).rejects.toThrow();
    expect((await row()).technicianId).toBeNull();

    await assignTechnician(requestId, tech.id, spec("maintenance_technician_assigned"));
    expect((await row()).technicianId).toBe(tech.id);
    expect(await events("maintenance_technician_assigned")).toHaveLength(1);
  });

  it("start records its event, or rolls back if it can't", async () => {
    await approve();
    await assignTechnician(requestId, tech.id);

    await expect(startMaintenanceRequest(requestId, boom as never)).rejects.toThrow();
    expect((await row()).status).toBe("APPROVED");

    await startMaintenanceRequest(requestId, spec("maintenance_in_progress"));
    expect((await row()).status).toBe("IN_PROGRESS");
    expect(await events("maintenance_in_progress")).toHaveLength(1);
  });

  it("a refused transition records no event", async () => {
    await expect(
      startMaintenanceRequest(requestId, spec("maintenance_in_progress"))
    ).rejects.toMatchObject({ status: 409 });
    expect(await prisma.activityLog.count()).toBe(0);
  });
});
