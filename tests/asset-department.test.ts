import { describe, it, expect, beforeEach } from "vitest";
import { GET as listAssets, POST as createAsset } from "@/app/api/assets/route";
import { GET as getAsset, PATCH as patchAsset } from "@/app/api/assets/[id]/route";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createCategory, createDepartment } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call, jsonRequest } from "./helpers/http";

type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: ReturnType<typeof jsonRequest>, ctx: Ctx) => Promise<Response>;

async function callWithId(handler: Handler, method: string, id: number, body?: unknown) {
  const res = await handler(jsonRequest(`/api/assets/${id}`, method, body), {
    params: Promise.resolve({ id: String(id) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json };
}

describe("asset owning department", () => {
  let categoryId: number;

  beforeEach(async () => {
    await resetDb();
    signInAs(await createUser({ role: "ADMIN" }));
    categoryId = (await createCategory()).id;
  });

  const create = (extra: object = {}) =>
    call(createAsset, "POST", "/api/assets", { name: "Laptop", categoryId, ...extra });
  const edit = (id: number, body: unknown) => callWithId(patchAsset, "PATCH", id, body);

  it("creates an asset with no department by default", async () => {
    const res = await create();

    expect(res.status).toBe(201);
    expect(res.body.departmentId).toBeNull();
    expect(res.body.department).toBeNull();
  });

  it("creates an asset owned by a department and returns its name", async () => {
    const dept = await createDepartment("Finance");

    const res = await create({ departmentId: dept.id });

    expect(res.status).toBe(201);
    expect(res.body.departmentId).toBe(dept.id);
    expect(res.body.department).toEqual({ id: dept.id, name: "Finance" });
  });

  it("rejects an unknown department on create", async () => {
    const res = await create({ departmentId: 999999 });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe("departmentId");
    expect(await prisma.asset.count()).toBe(0);
  });

  it("rejects an inactive department on create", async () => {
    const dept = await createDepartment();
    await prisma.department.update({ where: { id: dept.id }, data: { status: "INACTIVE" } });

    const res = await create({ departmentId: dept.id });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe("departmentId");
  });

  it("sets, changes and clears the department with PATCH", async () => {
    const a = await createDepartment("A");
    const b = await createDepartment("B");
    const asset = (await create()).body;

    expect((await edit(asset.id, { departmentId: a.id })).body.departmentId).toBe(a.id);
    expect((await edit(asset.id, { departmentId: b.id })).body.department.name).toBe("B");
    const cleared = await edit(asset.id, { departmentId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.departmentId).toBeNull();
  });

  it("leaves the department alone when PATCH does not mention it", async () => {
    const dept = await createDepartment();
    const asset = (await create({ departmentId: dept.id })).body;

    const res = await edit(asset.id, { name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.departmentId).toBe(dept.id);
  });

  it("rejects an unknown or inactive department on PATCH", async () => {
    const inactive = await createDepartment();
    await prisma.department.update({ where: { id: inactive.id }, data: { status: "INACTIVE" } });
    const asset = (await create()).body;

    expect((await edit(asset.id, { departmentId: 999999 })).status).toBe(400);
    expect((await edit(asset.id, { departmentId: inactive.id })).status).toBe(400);
  });

  it("lets you re-save an asset whose department was deactivated later", async () => {
    const dept = await createDepartment();
    const asset = (await create({ departmentId: dept.id })).body;
    await prisma.department.update({ where: { id: dept.id }, data: { status: "INACTIVE" } });

    const res = await edit(asset.id, { name: "Still editable", departmentId: dept.id });

    expect(res.status).toBe(200);
    expect(res.body.departmentId).toBe(dept.id);
  });

  it("includes the department on GET /api/assets/:id", async () => {
    const dept = await createDepartment("Ops");
    const asset = (await create({ departmentId: dept.id })).body;

    const res = await callWithId(getAsset as Handler, "GET", asset.id);

    expect(res.body.department).toEqual({ id: dept.id, name: "Ops" });
  });

  it("filters the list by ?departmentId=", async () => {
    const a = await createDepartment("A");
    const b = await createDepartment("B");
    await create({ name: "In A", departmentId: a.id });
    await create({ name: "In B", departmentId: b.id });
    await create({ name: "Nobody's" });

    const res = await call(listAssets, "GET", `/api/assets?departmentId=${a.id}`);

    expect(res.status).toBe(200);
    const rows = res.body.data;
    expect(res.body.total).toBe(1);
    expect(rows.map((r: { name: string }) => r.name)).toEqual(["In A"]);
    expect(rows[0].department.name).toBe("A");
  });

  it("rejects a malformed ?departmentId=", async () => {
    for (const bad of ["abc", "0", "-3", "1.5"]) {
      const res = await call(listAssets, "GET", `/api/assets?departmentId=${bad}`);
      expect(res.status, bad).toBe(400);
    }
  });
});
