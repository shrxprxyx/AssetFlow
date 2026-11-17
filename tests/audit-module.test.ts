import { describe, it, expect, beforeEach } from "vitest";
import { POST as createCycle, GET as listCycles } from "@/app/api/audit-cycles/route";
import { GET as getCycle } from "@/app/api/audit-cycles/[id]/route";
import { POST as addAuditors, DELETE as removeAuditor } from "@/app/api/audit-cycles/[id]/auditors/route";
import { PATCH as recordFinding } from "@/app/api/audit-cycles/[id]/findings/route";
import { PATCH as resolveFinding } from "@/app/api/audit-cycles/[id]/findings/[findingId]/resolution/route";
import { GET as discrepancies } from "@/app/api/audit-cycles/[id]/discrepancies/route";
import { POST as closeCycle } from "@/app/api/audit-cycles/[id]/close/route";
import { prisma } from "@/services/prisma";
import { resetDb, createUser, createAsset, createDepartment } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { jsonRequest } from "./helpers/http";

type Handler = (req: never, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function send(handler: unknown, method: string, url: string, params: Record<string, string>, body?: unknown) {
  const res = await (handler as Handler)(jsonRequest(url, method, body) as never, { params: Promise.resolve(params) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json };
}

const DAY = 86_400_000;
const dates = () => ({
  startDate: new Date().toISOString(),
  endDate: new Date(Date.now() + 14 * DAY).toISOString(),
});

describe("audit module", () => {
  let admin: Awaited<ReturnType<typeof createUser>>;
  let manager: Awaited<ReturnType<typeof createUser>>;
  let auditor: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    await resetDb();
    admin = await createUser({ role: "ADMIN" });
    manager = await createUser({ role: "ASSET_MANAGER" });
    auditor = await createUser({ role: "ASSET_MANAGER" });
    signInAs(admin);
  });

  const create = (body: Record<string, unknown>) =>
    send(createCycle, "POST", "/api/audit-cycles", {}, { name: "Q4", scopeType: "ALL", ...dates(), ...body });

  const record = (cycleId: number, assetId: number, status = "MISSING") =>
    send(recordFinding, "PATCH", `/api/audit-cycles/${cycleId}/findings`, { id: String(cycleId) }, { assetId, status });

  const resolve = (cycleId: number, findingId: number, decision: string) =>
    send(
      resolveFinding,
      "PATCH",
      `/api/audit-cycles/${cycleId}/findings/${findingId}/resolution`,
      { id: String(cycleId), findingId: String(findingId) },
      { decision }
    );

  const close = (cycleId: number) =>
    send(closeCycle, "POST", `/api/audit-cycles/${cycleId}/close`, { id: String(cycleId) });

  describe("creating a cycle with auditors", () => {
    it("assigns one or more auditors and tells them", async () => {
      const res = await create({ auditorIds: [auditor.id, manager.id] });

      expect(res.status).toBe(201);
      const assigned = await prisma.auditAssignment.findMany({ where: { cycleId: res.body.cycle.id } });
      expect(assigned.map((a) => a.auditorId).sort()).toEqual([manager.id, auditor.id].sort());
      expect(await prisma.notification.count({ where: { userId: auditor.id, type: "audit_assigned" } })).toBe(1);
    });

    it("needs at least one auditor", async () => {
      const res = await create({ auditorIds: [] });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("auditorIds");
    });

    it("rejects an employee as auditor, and creates nothing", async () => {
      const employee = await createUser();

      const res = await create({ auditorIds: [employee.id] });

      expect(res.status).toBe(400);
      expect(await prisma.auditCycle.count()).toBe(0);
    });

    it("rejects a deactivated user and an unknown id", async () => {
      const gone = await createUser({ role: "ASSET_MANAGER", status: "INACTIVE" });

      expect((await create({ auditorIds: [gone.id] })).status).toBe(400);
      expect((await create({ auditorIds: [999_999] })).status).toBe(400);
    });

    it("a LOCATION cycle needs a location", async () => {
      expect((await create({ scopeType: "LOCATION", auditorIds: [auditor.id] })).status).toBe(400);

      const ok = await create({ scopeType: "LOCATION", scopeLocation: "Floor 2", auditorIds: [auditor.id] });
      expect(ok.status).toBe(201);
      expect(ok.body.cycle.scopeLocation).toBe("Floor 2");
    });

    it("only an Admin can create one", async () => {
      signInAs(manager);
      expect((await create({ auditorIds: [auditor.id] })).status).toBe(403);
    });

    it("the cycle list shows how many auditors each cycle has", async () => {
      await create({ auditorIds: [auditor.id, manager.id] });

      const res = await send(listCycles, "GET", "/api/audit-cycles", {});

      expect(res.body.data[0].auditorCount).toBe(2);
    });
  });

  describe("managing auditors", () => {
    async function cycleWith(...ids: number[]) {
      return (await create({ auditorIds: ids })).body.cycle.id as number;
    }
    const add = (cycleId: number, ids: number[]) =>
      send(addAuditors, "POST", `/api/audit-cycles/${cycleId}/auditors`, { id: String(cycleId) }, { auditorIds: ids });
    const remove = (cycleId: number, auditorId: number) =>
      send(removeAuditor, "DELETE", `/api/audit-cycles/${cycleId}/auditors?auditorId=${auditorId}`, { id: String(cycleId) });

    it("adds an auditor, skipping anyone already assigned", async () => {
      const cycleId = await cycleWith(auditor.id);

      const res = await add(cycleId, [auditor.id, manager.id]);

      expect(res.body.added).toBe(1);
      expect(await prisma.auditAssignment.count({ where: { cycleId } })).toBe(2);
    });

    it("removes an auditor but never the last one", async () => {
      const cycleId = await cycleWith(auditor.id, manager.id);

      expect((await remove(cycleId, manager.id)).status).toBe(200);
      const last = await remove(cycleId, auditor.id);

      expect(last.status).toBe(409);
      expect(last.body.error).toBe("last_auditor");
      expect(await prisma.auditAssignment.count({ where: { cycleId } })).toBe(1);
    });

    it("can't change auditors on a closed cycle", async () => {
      const cycleId = await cycleWith(auditor.id);
      await close(cycleId);

      expect((await add(cycleId, [manager.id])).status).toBe(409);
    });

    it("only an Admin can", async () => {
      const cycleId = await cycleWith(auditor.id);
      signInAs(manager);

      expect((await add(cycleId, [manager.id])).status).toBe(403);
    });
  });

  describe("recording findings", () => {
    it("only an assigned auditor can", async () => {
      const cycleId = (await create({ auditorIds: [auditor.id] })).body.cycle.id;
      const asset = await createAsset();

      signInAs(manager); // an Asset Manager, but not on this cycle
      expect((await record(cycleId, asset.id)).status).toBe(403);

      signInAs(admin); // even an Admin has to be assigned
      expect((await record(cycleId, asset.id)).body.error).toBe("not_assigned");

      signInAs(auditor);
      expect((await record(cycleId, asset.id)).status).toBe(200);
    });

    it("refuses an asset outside a department cycle's scope", async () => {
      const dept = await createDepartment("Engineering");
      const inside = await createAsset({ location: "Engineering Floor 2" });
      const outside = await createAsset({ location: "Warehouse" });
      const cycleId = (await create({ scopeType: "DEPARTMENT", scopeId: dept.id, auditorIds: [auditor.id] })).body.cycle.id;

      signInAs(auditor);
      expect((await record(cycleId, inside.id)).status).toBe(200);
      const res = await record(cycleId, outside.id);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("asset_out_of_scope");
    });

    it("refuses an asset outside a location cycle's scope", async () => {
      const inside = await createAsset({ location: "HQ Floor 2, Room 4" });
      const outside = await createAsset({ location: "HQ Floor 3" });
      const cycleId = (
        await create({ scopeType: "LOCATION", scopeLocation: "floor 2", auditorIds: [auditor.id] })
      ).body.cycle.id;

      signInAs(auditor);
      expect((await record(cycleId, inside.id)).status).toBe(200);
      expect((await record(cycleId, outside.id)).body.error).toBe("asset_out_of_scope");
    });

    it("the checklist of a location cycle lists only the assets in that location", async () => {
      await createAsset({ location: "HQ Floor 2" });
      await createAsset({ location: "HQ Floor 3" });
      const cycleId = (
        await create({ scopeType: "LOCATION", scopeLocation: "Floor 2", auditorIds: [auditor.id] })
      ).body.cycle.id;

      const res = await send(getCycle, "GET", `/api/audit-cycles/${cycleId}`, { id: String(cycleId) });

      expect(res.body.checklist).toHaveLength(1);
    });

    it("checking the same asset twice keeps one finding", async () => {
      const cycleId = (await create({ auditorIds: [auditor.id] })).body.cycle.id;
      const asset = await createAsset();
      signInAs(auditor);

      await record(cycleId, asset.id, "MISSING");
      await record(cycleId, asset.id, "DAMAGED");

      expect(await prisma.auditFinding.count({ where: { cycleId, assetId: asset.id } })).toBe(1);
    });

    it("two simultaneous checks of one asset still leave one finding", async () => {
      const cycleId = (await create({ auditorIds: [auditor.id, manager.id] })).body.cycle.id;
      const asset = await createAsset();
      signInAs(auditor);

      const results = await Promise.all([record(cycleId, asset.id, "MISSING"), record(cycleId, asset.id, "VERIFIED")]);

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await prisma.auditFinding.count({ where: { cycleId, assetId: asset.id } })).toBe(1);
    });

    it("the database itself refuses a second finding for the same asset in a cycle", async () => {
      const cycleId = (await create({ auditorIds: [auditor.id] })).body.cycle.id;
      const asset = await createAsset();
      const data = { cycleId, assetId: asset.id, auditorId: auditor.id, status: "MISSING" as const };
      await prisma.auditFinding.create({ data });

      await expect(prisma.auditFinding.create({ data })).rejects.toThrow();
    });

    it("changing the verdict sends an approved finding back to pending", async () => {
      const cycleId = (await create({ auditorIds: [auditor.id] })).body.cycle.id;
      const asset = await createAsset();
      signInAs(auditor);
      const finding = (await record(cycleId, asset.id, "MISSING")).body.finding;
      signInAs(manager);
      await resolve(cycleId, finding.id, "APPROVED");

      signInAs(auditor);
      const changed = await record(cycleId, asset.id, "DAMAGED");

      expect(changed.body.finding.resolutionStatus).toBe("PENDING");
      expect(changed.body.finding.resolvedBy).toBeNull();
    });

    it("repeating the same verdict keeps the decision", async () => {
      const cycleId = (await create({ auditorIds: [auditor.id] })).body.cycle.id;
      const asset = await createAsset();
      signInAs(auditor);
      const finding = (await record(cycleId, asset.id, "MISSING")).body.finding;
      signInAs(manager);
      await resolve(cycleId, finding.id, "APPROVED");

      signInAs(auditor);
      const again = await record(cycleId, asset.id, "MISSING");

      expect(again.body.finding.resolutionStatus).toBe("APPROVED");
    });

    it("an Employee can't record findings", async () => {
      const cycleId = (await create({ auditorIds: [auditor.id] })).body.cycle.id;
      const asset = await createAsset();
      signInAs(await createUser());

      expect((await record(cycleId, asset.id)).status).toBe(403);
    });
  });

  describe("the discrepancy report and approval", () => {
    async function flaggedCycle() {
      const cycleId = (await create({ auditorIds: [auditor.id] })).body.cycle.id as number;
      const missing = await createAsset({ name: "Projector" });
      const damaged = await createAsset({ name: "Chair" });
      const fine = await createAsset({ name: "Desk" });
      signInAs(auditor);
      const a = (await record(cycleId, missing.id, "MISSING")).body.finding;
      const b = (await record(cycleId, damaged.id, "DAMAGED")).body.finding;
      await record(cycleId, fine.id, "VERIFIED");
      signInAs(manager);
      return { cycleId, missing, damaged, fine, a, b };
    }

    it("lists only flagged assets, with a summary", async () => {
      const { cycleId } = await flaggedCycle();

      const res = await send(discrepancies, "GET", `/api/audit-cycles/${cycleId}/discrepancies`, { id: String(cycleId) });

      expect(res.status).toBe(200);
      expect(res.body.data.map((d: { asset: { name: string } }) => d.asset.name).sort()).toEqual(["Chair", "Projector"]);
      expect(res.body.summary).toMatchObject({ total: 2, missing: 1, damaged: 1, pending: 2, approved: 0, rejected: 0 });
    });

    it("an Employee can't read the report", async () => {
      const { cycleId } = await flaggedCycle();
      signInAs(await createUser());

      const res = await send(discrepancies, "GET", `/api/audit-cycles/${cycleId}/discrepancies`, { id: String(cycleId) });

      expect(res.status).toBe(403);
    });

    it("an Asset Manager approves, and the report and activity log show it", async () => {
      const { cycleId, a } = await flaggedCycle();

      const res = await resolve(cycleId, a.id, "APPROVED");

      expect(res.status).toBe(200);
      expect(res.body.finding.resolutionStatus).toBe("APPROVED");
      expect(res.body.finding.resolvedBy).toBe(manager.id);
      expect(await prisma.activityLog.count({ where: { action: "audit_discrepancy_resolved" } })).toBe(1);
    });

    it("an auditor who is not an Asset Manager or Admin can't decide", async () => {
      const head = await createUser({ role: "DEPARTMENT_HEAD" });
      const cycleId = (await create({ auditorIds: [head.id] })).body.cycle.id;
      const asset = await createAsset();
      signInAs(head);
      const finding = (await record(cycleId, asset.id, "MISSING")).body.finding;

      expect((await resolve(cycleId, finding.id, "APPROVED")).status).toBe(403);
    });

    it("verified findings need no decision", async () => {
      const { cycleId, fine } = await flaggedCycle();
      const verified = await prisma.auditFinding.findFirstOrThrow({ where: { cycleId, assetId: fine.id } });

      const res = await resolve(cycleId, verified.id, "APPROVED");

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("not_a_discrepancy");
    });

    it("rejects a bad decision and a finding from another cycle", async () => {
      const { cycleId, a } = await flaggedCycle(); // leaves the Asset Manager signed in
      signInAs(admin); // only an Admin can create a cycle
      const otherCycle = (await create({ auditorIds: [auditor.id] })).body.cycle.id;
      signInAs(manager);

      expect((await resolve(cycleId, a.id, "MAYBE")).status).toBe(400);
      expect((await resolve(otherCycle, a.id, "APPROVED")).status).toBe(404);
    });

    it("decisions are locked once the cycle is closed", async () => {
      const { cycleId, a, b } = await flaggedCycle();
      await resolve(cycleId, a.id, "APPROVED");
      await resolve(cycleId, b.id, "REJECTED");
      signInAs(admin);
      await close(cycleId);

      signInAs(manager);
      expect((await resolve(cycleId, a.id, "REJECTED")).status).toBe(409);
    });

    it("closing needs every decision; then only approved missing assets become Lost", async () => {
      const { cycleId, missing, damaged, a, b } = await flaggedCycle();
      signInAs(admin);
      expect((await close(cycleId)).body.error).toBe("unresolved_discrepancies");

      signInAs(manager);
      await resolve(cycleId, a.id, "APPROVED");
      await resolve(cycleId, b.id, "APPROVED");
      signInAs(admin);
      const res = await close(cycleId);

      expect(res.status).toBe(200);
      expect((await prisma.asset.findUniqueOrThrow({ where: { id: missing.id } })).status).toBe("LOST");
      expect((await prisma.asset.findUniqueOrThrow({ where: { id: damaged.id } })).status).toBe("AVAILABLE");
    });
  });

  describe("cycle detail permissions", () => {
    it("tells the page what this person may do", async () => {
      const cycleId = (await create({ auditorIds: [auditor.id] })).body.cycle.id;
      const get = () => send(getCycle, "GET", `/api/audit-cycles/${cycleId}`, { id: String(cycleId) });

      signInAs(auditor);
      expect((await get()).body.permissions).toEqual({ canRecord: true, canResolve: true, canManageAuditors: false });

      signInAs(admin);
      expect((await get()).body.permissions).toEqual({ canRecord: false, canResolve: true, canManageAuditors: true });

      const head = await createUser({ role: "DEPARTMENT_HEAD" });
      signInAs(head);
      expect((await get()).body.permissions).toEqual({ canRecord: false, canResolve: false, canManageAuditors: false });
    });
  });
});