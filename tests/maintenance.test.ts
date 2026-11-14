import { describe, it, expect, beforeEach } from "vitest";
import { POST as raise } from "@/app/api/maintenance-requests/route";
import {
  approveMaintenanceRequest,
  rejectMaintenanceRequest,
  assignTechnician,
  startMaintenanceRequest,
  resolveMaintenanceRequest,
} from "@/lib/maintenance";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call } from "./helpers/http";

const makeRequest = (assetId: number, requesterId: number) =>
  prisma.maintenanceRequest.create({
    data: { assetId, requesterId, description: "Screen is cracked", priority: "MEDIUM" },
  });

const assetStatus = async (id: number) =>
  (await prisma.asset.findUniqueOrThrow({ where: { id } })).status;

/** Approve -> assign -> start, leaving the request IN_PROGRESS. */
async function startWork(requestId: number, managerId: number, techId: number) {
  await approveMaintenanceRequest(requestId, managerId);
  await assignTechnician(requestId, techId);
  await startMaintenanceRequest(requestId);
}

describe("maintenance workflow", () => {
  let manager: Awaited<ReturnType<typeof createUser>>;
  let tech: Awaited<ReturnType<typeof createUser>>;
  let employee: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    await resetDb();
    manager = await createUser({ role: "ASSET_MANAGER" });
    tech = await createUser();
    employee = await createUser();
  });

  describe("raising a request", () => {
    it("is refused for lost, retired and disposed assets", async () => {
      signInAs(employee);
      for (const status of ["LOST", "RETIRED", "DISPOSED"] as const) {
        const asset = await createAsset({ status });
        const res = await call(raise, "POST", "/api/maintenance-requests", {
          assetId: asset.id,
          description: "Something is wrong",
        });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("asset_not_maintainable");
      }
      expect(await prisma.maintenanceRequest.count()).toBe(0);
    });

    it("answers 404 for an unknown asset and 201 for a normal one", async () => {
      signInAs(employee);
      const missing = await call(raise, "POST", "/api/maintenance-requests", {
        assetId: 999999,
        description: "Something is wrong",
      });
      expect(missing.status).toBe(404);

      const asset = await createAsset();
      const ok = await call(raise, "POST", "/api/maintenance-requests", {
        assetId: asset.id,
        description: "Something is wrong",
      });
      expect(ok.status).toBe(201);
    });
  });

  describe("approval", () => {
    it("moves the asset to UNDER_MAINTENANCE and records history", async () => {
      const asset = await createAsset();
      const req = await makeRequest(asset.id, employee.id);

      await approveMaintenanceRequest(req.id, manager.id);

      expect(await assetStatus(asset.id)).toBe("UNDER_MAINTENANCE");
      const history = await prisma.assetHistory.findMany({ where: { assetId: asset.id } });
      expect(history).toHaveLength(1);
      expect(history[0].toStatus).toBe("UNDER_MAINTENANCE");
    });

    it("refuses to approve a request for an asset that has since been lost", async () => {
      const asset = await createAsset();
      const req = await makeRequest(asset.id, employee.id);
      await prisma.asset.update({ where: { id: asset.id }, data: { status: "LOST" } });

      await expect(approveMaintenanceRequest(req.id, manager.id)).rejects.toMatchObject({
        status: 409,
        body: { error: "asset_not_maintainable" },
      });
      expect(await assetStatus(asset.id)).toBe("LOST");
      expect((await prisma.maintenanceRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("PENDING");
    });

    it("lets exactly one of many simultaneous approvals win", async () => {
      const asset = await createAsset();
      const req = await makeRequest(asset.id, employee.id);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => approveMaintenanceRequest(req.id, manager.id))
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(9);
      expect(rejected.every((r) => r.reason?.status === 409)).toBe(true);
      expect(
        await prisma.assetHistory.count({ where: { assetId: asset.id, toStatus: "UNDER_MAINTENANCE" } })
      ).toBe(1);
    });

    it("cannot approve or reject a request that was already decided", async () => {
      const asset = await createAsset();
      const req = await makeRequest(asset.id, employee.id);
      await rejectMaintenanceRequest(req.id, manager.id);

      await expect(approveMaintenanceRequest(req.id, manager.id)).rejects.toMatchObject({ status: 409 });
      await expect(rejectMaintenanceRequest(req.id, manager.id)).rejects.toMatchObject({ status: 409 });
      expect(await assetStatus(asset.id)).toBe("AVAILABLE");
    });

    it("lets exactly one of many simultaneous rejections win", async () => {
      const asset = await createAsset();
      const req = await makeRequest(asset.id, employee.id);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => rejectMaintenanceRequest(req.id, manager.id))
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });
  });

  describe("technician and start", () => {
    it("only accepts a real, active technician", async () => {
      const asset = await createAsset();
      const req = await makeRequest(asset.id, employee.id);
      await approveMaintenanceRequest(req.id, manager.id);
      const inactive = await createUser({ status: "INACTIVE" });

      await expect(assignTechnician(req.id, 999999)).rejects.toMatchObject({
        status: 400,
        body: { error: "invalid_technician" },
      });
      await expect(assignTechnician(req.id, inactive.id)).rejects.toMatchObject({
        status: 400,
        body: { error: "invalid_technician" },
      });

      const ok = await assignTechnician(req.id, tech.id);
      expect(ok.technicianId).toBe(tech.id);
    });

    it("cannot start without a technician, or before approval", async () => {
      const asset = await createAsset();
      const req = await makeRequest(asset.id, employee.id);

      await expect(startMaintenanceRequest(req.id)).rejects.toMatchObject({ status: 409 });

      await approveMaintenanceRequest(req.id, manager.id);
      await expect(startMaintenanceRequest(req.id)).rejects.toMatchObject({
        status: 409,
        body: { error: "no_technician" },
      });
    });

    it("lets exactly one of many simultaneous starts win", async () => {
      const asset = await createAsset();
      const req = await makeRequest(asset.id, employee.id);
      await approveMaintenanceRequest(req.id, manager.id);
      await assignTechnician(req.id, tech.id);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => startMaintenanceRequest(req.id))
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });
  });

  describe("resolving", () => {
    it("returns the asset to AVAILABLE", async () => {
      const asset = await createAsset();
      const req = await makeRequest(asset.id, employee.id);
      await startWork(req.id, manager.id, tech.id);

      await resolveMaintenanceRequest(req.id, manager.id, "Replaced the screen");

      expect(await assetStatus(asset.id)).toBe("AVAILABLE");
      const done = await prisma.maintenanceRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(done.status).toBe("RESOLVED");
      expect(done.resolutionNotes).toBe("Replaced the screen");
    });

    it("returns an asset someone still holds to ALLOCATED", async () => {
      const asset = await createAsset({ status: "ALLOCATED" });
      await prisma.allocation.create({
        data: { assetId: asset.id, holderId: employee.id, holderType: "EMPLOYEE", status: "ACTIVE" },
      });
      const req = await makeRequest(asset.id, employee.id);
      await startWork(req.id, manager.id, tech.id);
      expect(await assetStatus(asset.id)).toBe("UNDER_MAINTENANCE");

      await resolveMaintenanceRequest(req.id, manager.id);

      expect(await assetStatus(asset.id)).toBe("ALLOCATED");
    });

    it("keeps the asset in maintenance while another request is still open", async () => {
      const asset = await createAsset();
      const first = await makeRequest(asset.id, employee.id);
      const second = await makeRequest(asset.id, employee.id);
      await startWork(first.id, manager.id, tech.id);
      await startWork(second.id, manager.id, tech.id);

      await resolveMaintenanceRequest(first.id, manager.id);
      expect(await assetStatus(asset.id)).toBe("UNDER_MAINTENANCE");

      await resolveMaintenanceRequest(second.id, manager.id);
      expect(await assetStatus(asset.id)).toBe("AVAILABLE");
    });

    it("does not bring a lost asset back to life", async () => {
      const asset = await createAsset();
      const req = await makeRequest(asset.id, employee.id);
      await startWork(req.id, manager.id, tech.id);
      await prisma.asset.update({ where: { id: asset.id }, data: { status: "LOST" } });

      await resolveMaintenanceRequest(req.id, manager.id);

      expect(await assetStatus(asset.id)).toBe("LOST");
    });

    it("cannot resolve a request that is not in progress", async () => {
      const asset = await createAsset();
      const req = await makeRequest(asset.id, employee.id);

      await expect(resolveMaintenanceRequest(req.id, manager.id)).rejects.toMatchObject({ status: 409 });
      await approveMaintenanceRequest(req.id, manager.id);
      await expect(resolveMaintenanceRequest(req.id, manager.id)).rejects.toMatchObject({ status: 409 });
    });
  });
});