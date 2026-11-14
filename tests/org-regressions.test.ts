import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as listAssets } from "@/app/api/assets/route";
import { POST as createDepartment, PUT as updateDepartment } from "@/app/api/departments/route";
import { POST as createCategory, PUT as updateCategory } from "@/app/api/asset-categories/route";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call } from "./helpers/http";

describe("regressions for bugs we fixed", () => {
  beforeEach(async () => {
    await resetDb();
    signInAs(await createUser({ role: "ADMIN" }));
  });

  it("renaming a deactivated department does NOT reactivate it", async () => {
    const dept = await prisma.department.create({ data: { name: "Old", status: "INACTIVE" } });

    const res = await call(updateDepartment, "PUT", "/api/departments", { id: dept.id, name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed");
    expect(res.body.status).toBe("INACTIVE");
  });

  it("refuses a department parent loop", async () => {
    const a = await prisma.department.create({ data: { name: "A" } });
    const b = await prisma.department.create({ data: { name: "B", parentDeptId: a.id } });

    const self = await call(updateDepartment, "PUT", "/api/departments", { id: a.id, parentDeptId: a.id });
    const loop = await call(updateDepartment, "PUT", "/api/departments", { id: a.id, parentDeptId: b.id });

    expect(self.status).toBe(400);
    expect(loop.status).toBe(400);
  });

  it("saves the department description on create", async () => {
    const res = await call(createDepartment, "POST", "/api/departments", { name: "Ops", description: "Operations" });
    expect(res.status).toBe(201);
    expect(res.body.description).toBe("Operations");
  });

  it("renaming a category keeps its custom fields", async () => {
    const cat = await prisma.assetCategory.create({ data: { name: "Laptops", customFields: '{"a":1}' } });

    const res = await call(updateCategory, "PUT", "/api/asset-categories", { id: cat.id, name: "Notebooks" });

    expect(res.status).toBe(200);
    expect(res.body.customFields).toBe('{"a":1}');
  });

  it("reports a duplicate category name as 409", async () => {
    await call(createCategory, "POST", "/api/asset-categories", { name: "Dup" });
    const again = await call(createCategory, "POST", "/api/asset-categories", { name: "Dup" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("name_taken");
  });

  it("asset search ignores letter case", async () => {
    await createAsset({ name: "Dell Laptop", location: "Engineering Floor 2" });
    await createAsset({ name: "Projector" });

    const byName = await call(listAssets, "GET", "/api/assets?name=laptop");
    expect(byName.body).toHaveLength(1);
    expect(byName.body[0].name).toBe("Dell Laptop");

    const byLocation = await call(listAssets, "GET", "/api/assets?location=ENGINEERING");
    expect(byLocation.body).toHaveLength(1);
  });

  it("answers malformed JSON with a 400, not a crash", async () => {
    const req = new NextRequest("http://localhost/api/departments", { method: "POST", body: "{oops" });
    const res = await createDepartment(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });
});