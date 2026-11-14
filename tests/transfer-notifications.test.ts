import { describe, it, expect, beforeEach } from "vitest";
import { createTransferRequest, approveTransfer, rejectTransfer, cancelTransfer } from "@/lib/transfers";
import type { Actor } from "@/lib/transfers";
import { logActivity } from "@/lib/logActivity";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset, createDepartment } from "./helpers/db";

type U = Awaited<ReturnType<typeof createUser>>;
const actor = (u: U): Actor => ({ userId: u.id, role: u.role, departmentId: u.departmentId });

const notified = async (type: string) =>
  (await prisma.notification.findMany({ where: { type }, orderBy: { userId: "asc" } })).map((n) => n.userId);

describe("transfer notifications", () => {
  let admin: U, manager: U, headA: U, headB: U, holder: U, requester: U, bystander: U;
  let assetId: number;

  beforeEach(async () => {
    await resetDb();
    const [deptA, deptB] = await Promise.all([createDepartment("A"), createDepartment("B")]);
    admin = await createUser({ role: "ADMIN" });
    manager = await createUser({ role: "ASSET_MANAGER" });
    headA = await createUser({ role: "DEPARTMENT_HEAD", departmentId: deptA.id });
    headB = await createUser({ role: "DEPARTMENT_HEAD", departmentId: deptB.id });
    holder = await createUser({ departmentId: deptA.id });
    requester = await createUser({ departmentId: deptB.id });
    bystander = await createUser({ departmentId: deptB.id });

    const asset = await createAsset({ status: "ALLOCATED" });
    assetId = asset.id;
    await prisma.allocation.create({
      data: { assetId, holderId: holder.id, holderType: "EMPLOYEE", status: "ACTIVE" },
    });
  });

  /** An employee asks for the asset for themselves; returns the request id. */
  async function employeeRequests() {
    const { request } = await createTransferRequest(actor(requester), { assetId, toHolderId: requester.id });
    await logActivity("transfer_requested", {
      actorId: requester.id,
      resourceType: "TransferRequest",
      resourceId: request.id,
    });
    return request.id;
  }

  it("tells the approvers, the holder's department head and the holder when a request is made", async () => {
    await employeeRequests();

    const ids = await notified("transfer_requested");
    expect(ids.sort()).toEqual([admin.id, manager.id, headA.id, holder.id].sort());
    // Not the requester, not an unrelated employee, not another department's head.
    expect(ids).not.toContain(requester.id);
    expect(ids).not.toContain(bystander.id);
    expect(ids).not.toContain(headB.id);
  });

  it("sends each person only one notification per event", async () => {
    await employeeRequests();
    const ids = await notified("transfer_requested");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("on approval tells the requester (once) and the previous holder, not the approver", async () => {
    const requestId = await employeeRequests();
    await approveTransfer(actor(manager), requestId);
    await logActivity("transfer_approved", {
      actorId: manager.id,
      resourceType: "TransferRequest",
      resourceId: requestId,
    });

    const ids = await notified("transfer_approved");
    // The requester is also the new holder, so they appear once.
    expect(ids.sort()).toEqual([requester.id, holder.id].sort());
    expect(ids).not.toContain(manager.id);
  });

  it("when a manager hands the asset to someone else, the new and previous holders are told", async () => {
    const { request, autoApproved } = await createTransferRequest(actor(manager), {
      assetId,
      toHolderId: bystander.id,
    });
    expect(autoApproved).toBe(true);
    await logActivity("transfer_completed", {
      actorId: manager.id,
      resourceType: "TransferRequest",
      resourceId: request.id,
    });

    const ids = await notified("transfer_completed");
    expect(ids.sort()).toEqual([bystander.id, holder.id].sort());
    expect(ids).not.toContain(manager.id);
  });

  it("a manager's own request does not create an approval notification", async () => {
    const { request } = await createTransferRequest(actor(manager), { assetId, toHolderId: bystander.id });
    await logActivity("transfer_requested", {
      actorId: manager.id,
      resourceType: "TransferRequest",
      resourceId: request.id,
    });
    expect(await notified("transfer_requested")).toEqual([]);
  });

  it("tells only the requester when a request is rejected", async () => {
    const requestId = await employeeRequests();
    await rejectTransfer(actor(manager), requestId);
    await logActivity("transfer_rejected", {
      actorId: manager.id,
      resourceType: "TransferRequest",
      resourceId: requestId,
    });

    expect(await notified("transfer_rejected")).toEqual([requester.id]);
  });

  it("does not notify requesters about cancelling their own request", async () => {
    const requestId = await employeeRequests();
    await cancelTransfer(actor(requester), requestId);
    await logActivity("transfer_cancelled", {
      actorId: requester.id,
      resourceType: "TransferRequest",
      resourceId: requestId,
    });

    expect(await notified("transfer_cancelled")).toEqual([]);
  });
});