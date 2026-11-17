import { describe, it, expect, beforeEach } from "vitest";
import { GET as listAssets } from "@/app/api/assets/route";
import { GET as listAllocations } from "@/app/api/allocations/route";
import { GET as listEmployees } from "@/app/api/employees/route";
import { GET as listActivity } from "@/app/api/activity/route";
import { GET as listTransfers } from "@/app/api/transfers/route";
import { GET as listMaintenance } from "@/app/api/maintenance-requests/route";
import { GET as listCycles } from "@/app/api/audit-cycles/route";
import { GET as assetHistory } from "@/app/api/assets/[id]/history/route";
import { parsePagination, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/utils/pagination";
import { prisma } from "@/services/prisma";
import { resetDb, createUser, createAsset, createCategory, createDepartment } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call, jsonRequest } from "./helpers/http";

const params = (query: string) => new URLSearchParams(query);

describe("parsePagination", () => {
  it("defaults to page 1 and the default page size", () => {
    const res = parsePagination(params(""));
    expect(res.ok && res.page).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE, skip: 0, take: DEFAULT_PAGE_SIZE });
  });

  it("turns page and pageSize into skip and take", () => {
    const res = parsePagination(params("page=3&pageSize=10"));
    expect(res.ok && res.page).toEqual({ page: 3, pageSize: 10, skip: 20, take: 10 });
  });

  it("caps an oversized pageSize instead of rejecting it", () => {
    const res = parsePagination(params("pageSize=5000"));
    expect(res.ok && res.page.pageSize).toBe(MAX_PAGE_SIZE);
  });

  it.each(["page=0", "page=-1", "page=abc", "page=1.5", "pageSize=0", "pageSize=-5", "pageSize=ten"])(
    "rejects %s with a 400",
    async (query) => {
      const res = parsePagination(params(query));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(400);
        const body = await res.response.json();
        expect(body.error).toBe("validation_error");
        expect(body.field).toBe(query.split("=")[0]);
      }
    }
  );
});

describe("paginated list endpoints", () => {
  let admin: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    await resetDb();
    admin = await createUser({ role: "ADMIN" });
    signInAs(admin);
  });

  const assets = (query = "") => call(listAssets, "GET", `/api/assets${query}`);

  async function createAssets(count: number, o: Parameters<typeof createAsset>[0] = {}) {
    const categoryId = o.categoryId ?? (await createCategory()).id;
    for (let i = 0; i < count; i++) await createAsset({ ...o, categoryId });
  }

  it("returns { data, total, page, pageSize } with the default page size", async () => {
    await createAssets(30);

    const res = await assets();

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(res.body.total).toBe(30);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it("pages cover every row exactly once", async () => {
    await createAssets(12);

    const seen: number[] = [];
    for (const page of [1, 2, 3]) {
      const res = await assets(`?page=${page}&pageSize=5`);
      expect(res.body.total).toBe(12);
      expect(res.body.page).toBe(page);
      seen.push(...res.body.data.map((a: { id: number }) => a.id));
    }

    expect(seen).toHaveLength(12); // 5 + 5 + 2
    expect(new Set(seen).size).toBe(12); // no row twice, none missing
  });

  it("a page past the end is empty but still reports the total", async () => {
    await createAssets(3);

    const res = await assets("?page=9&pageSize=5");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(3);
  });

  it("total counts only the rows that match the filters", async () => {
    await createAssets(4, { status: "AVAILABLE" });
    await createAssets(7, { status: "RETIRED" });

    const res = await assets("?status=RETIRED&pageSize=5");

    expect(res.body.data).toHaveLength(5);
    expect(res.body.total).toBe(7);
  });

  it("caps pageSize at the maximum", async () => {
    await createAssets(3);

    const res = await assets("?pageSize=100000");

    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(MAX_PAGE_SIZE);
  });

  it("rejects a bad page or pageSize with 400", async () => {
    for (const query of ["?page=0", "?page=abc", "?pageSize=-1"]) {
      const res = await assets(query);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("validation_error");
    }
  });

  it("allocations: total respects what the role may see", async () => {
    const employee = await createUser();
    const other = await createUser();
    for (const holder of [employee, employee, other]) {
      const asset = await createAsset({ status: "ALLOCATED" });
      await prisma.allocation.create({
        data: { assetId: asset.id, holderId: holder.id, holderType: "EMPLOYEE", status: "ACTIVE" },
      });
    }

    const all = await call(listAllocations, "GET", "/api/allocations?pageSize=2");
    expect(all.body.data).toHaveLength(2);
    expect(all.body.total).toBe(3);

    signInAs(employee);
    const mine = await call(listAllocations, "GET", "/api/allocations");
    expect(mine.body.total).toBe(2);
    expect(mine.body.data).toHaveLength(2);
  });

  it("employees: paginated, and a Department Head only counts their own department", async () => {
    const dept = await createDepartment();
    const head = await createUser({ role: "DEPARTMENT_HEAD", departmentId: dept.id });
    await createUser({ departmentId: dept.id });
    await createUser({ departmentId: dept.id });
    await createUser(); // someone in no department

    const everyone = await call(listEmployees, "GET", "/api/employees?pageSize=2");
    expect(everyone.body.data).toHaveLength(2);
    expect(everyone.body.total).toBe(5); // admin + head + 3 employees

    signInAs(head);
    const own = await call(listEmployees, "GET", "/api/employees");
    expect(own.body.total).toBe(3); // the head and the two department members
  });

  it("activity: newest first, with a real total", async () => {
    for (let i = 0; i < 7; i++) {
      await prisma.activityLog.create({ data: { actorId: admin.id, action: `action_${i}` } });
    }

    const first = await call(listActivity, "GET", "/api/activity?pageSize=3");
    const second = await call(listActivity, "GET", "/api/activity?pageSize=3&page=2");

    expect(first.body.total).toBe(7);
    expect(first.body.data.map((l: { action: string }) => l.action)).toEqual(["action_6", "action_5", "action_4"]);
    expect(second.body.data.map((l: { action: string }) => l.action)).toEqual(["action_3", "action_2", "action_1"]);
  });

  it("activity: an employee's total counts only their own entries", async () => {
    const employee = await createUser();
    await prisma.activityLog.create({ data: { actorId: admin.id, action: "admin_thing" } });
    await prisma.activityLog.create({ data: { actorId: employee.id, action: "my_thing" } });

    signInAs(employee);
    const res = await call(listActivity, "GET", "/api/activity");

    expect(res.body.total).toBe(1);
    expect(res.body.data[0].action).toBe("my_thing");
  });

  it("transfers: paginated with a total", async () => {
    const requester = await createUser();
    for (let i = 0; i < 4; i++) {
      const asset = await createAsset({ status: "ALLOCATED" });
      await prisma.transferRequest.create({
        data: { assetId: asset.id, toHolderId: requester.id, requestedBy: requester.id, status: "PENDING" },
      });
    }

    const res = await call(listTransfers, "GET", "/api/transfers?pageSize=3");

    expect(res.body.data).toHaveLength(3);
    expect(res.body.total).toBe(4);
    expect(res.body.pageSize).toBe(3);
  });

  it("maintenance requests: paginated, and still returns the asset picker list", async () => {
    const asset = await createAsset();
    for (let i = 0; i < 4; i++) {
      await prisma.maintenanceRequest.create({
        data: { assetId: asset.id, requesterId: admin.id, description: `Broken thing ${i}` },
      });
    }

    const res = await call(listMaintenance, "GET", "/api/maintenance-requests?pageSize=3");

    expect(res.body.data).toHaveLength(3);
    expect(res.body.total).toBe(4);
    expect(res.body.assets).toHaveLength(1);
  });

  it("audit cycles: paginated, and still returns the departments list", async () => {
    await createDepartment("Engineering");
    for (let i = 0; i < 3; i++) {
      await prisma.auditCycle.create({
        data: { name: `Cycle ${i}`, scopeType: "ALL", startDate: new Date(), endDate: new Date(), createdBy: admin.id },
      });
    }

    const res = await call(listCycles, "GET", "/api/audit-cycles?pageSize=2");

    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.departments).toHaveLength(1);
    expect(res.body.data[0]).toHaveProperty("assetCount");
  });

  it("asset history: paginated with a total", async () => {
    const asset = await createAsset();
    for (let i = 0; i < 5; i++) {
      await prisma.assetHistory.create({
        data: { assetId: asset.id, toStatus: "AVAILABLE", actorId: admin.id, reason: `step ${i}` },
      });
    }

    const res = await assetHistory(jsonRequest(`/api/assets/${asset.id}/history?pageSize=2`, "GET"), {
      params: Promise.resolve({ id: String(asset.id) }),
    });
    const body = await res.json();

    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.page).toBe(1);
  });
});
