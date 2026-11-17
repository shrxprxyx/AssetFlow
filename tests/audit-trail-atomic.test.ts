import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST as promote } from "@/app/api/employees/[id]/promote/route";
import { POST as setDepartment } from "@/app/api/employees/[id]/department/route";
import { PATCH as setStatus } from "@/app/api/employees/[id]/status/route";
import { PATCH as editAsset } from "@/app/api/assets/[id]/route";
import { POST as changeAssetStatus } from "@/app/api/assets/[id]/status/route";
import { POST as raiseRequest } from "@/app/api/maintenance-requests/route";
import { POST as createCycle } from "@/app/api/audit-cycles/route";
import { POST as addAuditors, DELETE as removeAuditor } from "@/app/api/audit-cycles/[id]/auditors/route";
import { PATCH as recordFinding } from "@/app/api/audit-cycles/[id]/findings/route";
import { PATCH as resolveFinding } from "@/app/api/audit-cycles/[id]/findings/[findingId]/resolution/route";
import { prisma } from "@/services/prisma";
import { resetDb, createUser, createAsset, createDepartment } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { jsonRequest } from "./helpers/http";

// Every change below writes its audit entry in the same transaction. To prove it,
// the database refuses all new ActivityLog rows, so the audit write fails; the
// change must then not have happened.

type Handler = (req: never, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Calls a handler; an error thrown out of it counts the same as a 500. */
async function send(handler: unknown, method: string, url: string, params: Record<string, string>, body?: unknown) {
  try {
    const res = await (handler as Handler)(jsonRequest(url, method, body) as never, { params: Promise.resolve(params) });
    return res.status;
  } catch {
    return 500;
  }
}

const BLOCK = "activitylog_block_for_test";
const blockEvents = () =>
  prisma.$executeRawUnsafe(`ALTER TABLE "ActivityLog" ADD CONSTRAINT ${BLOCK} CHECK (false) NOT VALID`);
const unblockEvents = () => prisma.$executeRawUnsafe(`ALTER TABLE "ActivityLog" DROP CONSTRAINT IF EXISTS ${BLOCK}`);

const DAY = 86_400_000;
const dates = () => ({
  startDate: new Date().toISOString(),
  endDate: new Date(Date.now() + 14 * DAY).toISOString(),
});

describe("changes and their audit entries succeed or fail together", () => {
  let admin: Awaited<ReturnType<typeof createUser>>;
  let employee: Awaited<ReturnType<typeof createUser>>;
  let auditor: Awaited<ReturnType<typeof createUser>>;
  let other: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    await unblockEvents();
    await resetDb();
    admin = await createUser({ role: "ADMIN" });
    employee = await createUser();
    auditor = await createUser({ role: "ASSET_MANAGER" });
    other = await createUser({ role: "ASSET_MANAGER" });
    signInAs(admin);
  });
  afterEach(unblockEvents);

  const userRow = (id: number) => prisma.user.findUniqueOrThrow({ where: { id } });

  it("promote", async () => {
    await blockEvents();
    await send(promote, "POST", "/x", { id: String(employee.id) }, { role: "ASSET_MANAGER" });
    expect((await userRow(employee.id)).role).toBe("EMPLOYEE");

    await unblockEvents();
    expect(await send(promote, "POST", "/x", { id: String(employee.id) }, { role: "ASSET_MANAGER" })).toBe(200);
    expect((await userRow(employee.id)).role).toBe("ASSET_MANAGER");
    expect(await prisma.activityLog.count({ where: { action: "role_changed" } })).toBe(1);
  });

  it("department change", async () => {
    const dept = await createDepartment();
    await blockEvents();
    await send(setDepartment, "POST", "/x", { id: String(employee.id) }, { departmentId: dept.id });
    expect((await userRow(employee.id)).departmentId).toBeNull();

    await unblockEvents();
    expect(await send(setDepartment, "POST", "/x", { id: String(employee.id) }, { departmentId: dept.id })).toBe(200);
    expect((await userRow(employee.id)).departmentId).toBe(dept.id);
    expect(await prisma.activityLog.count({ where: { action: "employee_department_changed" } })).toBe(1);
  });

  it("status change", async () => {
    await blockEvents();
    await send(setStatus, "PATCH", "/x", { id: String(employee.id) }, { status: "INACTIVE" });
    expect((await userRow(employee.id)).status).toBe("ACTIVE");

    await unblockEvents();
    expect(await send(setStatus, "PATCH", "/x", { id: String(employee.id) }, { status: "INACTIVE" })).toBe(200);
    expect((await userRow(employee.id)).status).toBe("INACTIVE");
    expect(await prisma.activityLog.count({ where: { action: "employee_status_changed" } })).toBe(1);
  });

  it("asset edit", async () => {
    const asset = await createAsset({ name: "Old name" });
    const params = { id: String(asset.id) };
    await blockEvents();
    await send(editAsset, "PATCH", "/x", params, { name: "New name" });
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).name).toBe("Old name");

    await unblockEvents();
    expect(await send(editAsset, "PATCH", "/x", params, { name: "New name" })).toBe(200);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).name).toBe("New name");
    expect(await prisma.activityLog.count({ where: { action: "asset_updated" } })).toBe(1);
  });

  it("asset status change records the status event and one per cancelled booking", async () => {
    const room = await createAsset({ isBookable: true });
    await prisma.resourceBooking.create({
      data: {
        resourceId: room.id,
        bookerId: employee.id,
        startTime: new Date(Date.now() + DAY),
        endTime: new Date(Date.now() + DAY + 3_600_000),
        status: "UPCOMING",
      },
    });
    const params = { id: String(room.id) };

    await blockEvents();
    await send(changeAssetStatus, "POST", "/x", params, { status: "RETIRED" });
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: room.id } })).status).toBe("AVAILABLE");
    expect(await prisma.resourceBooking.count({ where: { status: "CANCELLED" } })).toBe(0);

    await unblockEvents();
    expect(await send(changeAssetStatus, "POST", "/x", params, { status: "RETIRED" })).toBe(200);
    expect(await prisma.activityLog.count({ where: { action: "asset_status_changed" } })).toBe(1);
    expect(await prisma.activityLog.count({ where: { action: "booking_cancelled" } })).toBe(1);
  });

  it("raising a maintenance request", async () => {
    const asset = await createAsset();
    const body = { assetId: asset.id, description: "Screen is cracked", priority: "LOW" };
    signInAs(employee);

    await blockEvents();
    await send(raiseRequest, "POST", "/x", {}, body);
    expect(await prisma.maintenanceRequest.count()).toBe(0);

    await unblockEvents();
    expect(await send(raiseRequest, "POST", "/x", {}, body)).toBe(201);
    const [request] = await prisma.maintenanceRequest.findMany();
    const [event] = await prisma.activityLog.findMany({ where: { action: "maintenance_raised" } });
    expect(event.resourceId).toBe(request.id);
  });

  describe("audit cycles", () => {
    const cycleBody = () => ({ name: "Q4", scopeType: "ALL", ...dates(), auditorIds: [auditor.id] });

    async function cycleWith(...ids: number[]) {
      const cycle = await prisma.auditCycle.create({
        data: { name: "Q4", scopeType: "ALL", startDate: new Date(), endDate: new Date(Date.now() + 14 * DAY), createdBy: admin.id },
      });
      await prisma.auditAssignment.createMany({ data: ids.map((auditorId) => ({ cycleId: cycle.id, auditorId })) });
      return cycle.id;
    }

    it("creating a cycle", async () => {
      await blockEvents();
      await send(createCycle, "POST", "/x", {}, cycleBody());
      expect(await prisma.auditCycle.count()).toBe(0);
      expect(await prisma.auditAssignment.count()).toBe(0);

      await unblockEvents();
      expect(await send(createCycle, "POST", "/x", {}, cycleBody())).toBe(201);
      expect(await prisma.activityLog.count({ where: { action: "audit_cycle_created" } })).toBe(1);
      expect(await prisma.activityLog.count({ where: { action: "audit_assigned" } })).toBe(1);
    });

    it("adding an auditor", async () => {
      const cycleId = await cycleWith(auditor.id);
      const params = { id: String(cycleId) };

      await blockEvents();
      await send(addAuditors, "POST", "/x", params, { auditorIds: [other.id] });
      expect(await prisma.auditAssignment.count({ where: { cycleId } })).toBe(1);

      await unblockEvents();
      expect(await send(addAuditors, "POST", "/x", params, { auditorIds: [other.id] })).toBe(201);
      expect(await prisma.auditAssignment.count({ where: { cycleId } })).toBe(2);
      expect(await prisma.activityLog.count({ where: { action: "audit_assigned" } })).toBe(1);
    });

    it("removing an auditor", async () => {
      const cycleId = await cycleWith(auditor.id, other.id);
      const params = { id: String(cycleId) };
      const url = `/x?auditorId=${other.id}`;

      await blockEvents();
      await send(removeAuditor, "DELETE", url, params);
      expect(await prisma.auditAssignment.count({ where: { cycleId } })).toBe(2);

      await unblockEvents();
      expect(await send(removeAuditor, "DELETE", url, params)).toBe(200);
      expect(await prisma.auditAssignment.count({ where: { cycleId } })).toBe(1);
      expect(await prisma.activityLog.count({ where: { action: "audit_auditor_removed" } })).toBe(1);
    });

    it("recording a finding", async () => {
      const cycleId = await cycleWith(auditor.id);
      const asset = await createAsset();
      const params = { id: String(cycleId) };
      signInAs(auditor);

      await blockEvents();
      await send(recordFinding, "PATCH", "/x", params, { assetId: asset.id, status: "MISSING" });
      expect(await prisma.auditFinding.count()).toBe(0);

      await unblockEvents();
      expect(await send(recordFinding, "PATCH", "/x", params, { assetId: asset.id, status: "MISSING" })).toBe(200);
      expect(await prisma.activityLog.count({ where: { action: "audit_finding_recorded" } })).toBe(1);
    });

    it("resolving a discrepancy", async () => {
      const cycleId = await cycleWith(auditor.id);
      const asset = await createAsset();
      const finding = await prisma.auditFinding.create({
        data: { cycleId, assetId: asset.id, auditorId: auditor.id, status: "MISSING", conditionBefore: "GOOD" },
      });
      const params = { id: String(cycleId), findingId: String(finding.id) };

      await blockEvents();
      await send(resolveFinding, "PATCH", "/x", params, { decision: "APPROVED" });
      expect((await prisma.auditFinding.findUniqueOrThrow({ where: { id: finding.id } })).resolutionStatus).toBe("PENDING");

      await unblockEvents();
      expect(await send(resolveFinding, "PATCH", "/x", params, { decision: "APPROVED" })).toBe(200);
      expect(await prisma.activityLog.count({ where: { action: "audit_discrepancy_resolved" } })).toBe(1);
    });
  });
});
