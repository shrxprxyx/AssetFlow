import { describe, it, expect, beforeEach } from "vitest";
import { POST as createAsset, GET as listAssets } from "@/app/api/assets/route";
import { POST as createDepartment } from "@/app/api/departments/route";
import { POST as createCategory } from "@/app/api/asset-categories/route";
import { GET as listEmployees } from "@/app/api/employees/route";
import { resetDb, createUser, createCategory as makeCategory } from "./helpers/db";
import { signInAs, signOut } from "./helpers/auth";
import { call } from "./helpers/http";

const newAsset = (categoryId: number) => call(createAsset, "POST", "/api/assets", { name: "Laptop", categoryId });

describe("role guards", () => {
  beforeEach(resetDb);

  it("401 when nobody is signed in", async () => {
    const cat = await makeCategory();
    signOut();

    expect((await newAsset(cat.id)).status).toBe(401);
    expect((await call(listAssets, "GET", "/api/assets")).status).toBe(401);
  });

  it("an Employee can read assets but cannot create or manage anything", async () => {
    const cat = await makeCategory();
    const employee = await createUser({ role: "EMPLOYEE" });
    signInAs(employee);

    expect((await call(listAssets, "GET", "/api/assets")).status).toBe(200);
    expect((await newAsset(cat.id)).status).toBe(403);
    expect((await call(createDepartment, "POST", "/api/departments", { name: "X" })).status).toBe(403);
    expect((await call(createCategory, "POST", "/api/asset-categories", { name: "X" })).status).toBe(403);
    expect((await call(listEmployees, "GET", "/api/employees")).status).toBe(403);
  });

  it("an Asset Manager can create assets and categories but not departments", async () => {
    const cat = await makeCategory();
    const manager = await createUser({ role: "ASSET_MANAGER" });
    signInAs(manager);

    expect((await newAsset(cat.id)).status).toBe(201);
    expect((await call(createCategory, "POST", "/api/asset-categories", { name: "Shiny" })).status).toBe(201);
    expect((await call(createDepartment, "POST", "/api/departments", { name: "X" })).status).toBe(403);
  });

  it("an Admin can do all of it", async () => {
    const cat = await makeCategory();
    const admin = await createUser({ role: "ADMIN" });
    signInAs(admin);

    expect((await newAsset(cat.id)).status).toBe(201);
    expect((await call(createDepartment, "POST", "/api/departments", { name: "Ops" })).status).toBe(201);
  });

  it("a deactivated user is rejected even though their session is still valid", async () => {
    const cat = await makeCategory();
    const manager = await createUser({ role: "ASSET_MANAGER", status: "INACTIVE" });
    signInAs(manager);

    const res = await newAsset(cat.id);
    expect(res.status).toBe(401);
  });

  it("trusts the database role, not a stale session role", async () => {
    const cat = await makeCategory();
    // In the database she is only an Employee, but her old token still says ASSET_MANAGER.
    const demoted = await createUser({ role: "EMPLOYEE" });
    signInAs(demoted, "ASSET_MANAGER");

    expect((await newAsset(cat.id)).status).toBe(403);
  });
});