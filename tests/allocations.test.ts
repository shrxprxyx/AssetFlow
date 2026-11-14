import { describe, it, expect, beforeEach } from "vitest";
import { POST as allocate } from "@/app/api/allocations/route";
import { returnAsset } from "@/lib/allocations";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset, createDepartment } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call } from "./helpers/http";

const post = (body: unknown) => call(allocate, "POST", "/api/allocations", body);

describe("POST /api/allocations", () => {
  beforeEach(resetDb);

  it("lets exactly one of many simultaneous requests win", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const asset = await createAsset();
    const holders = await Promise.all(Array.from({ length: 15 }, () => createUser()));
    signInAs(admin);

    const results = await Promise.all(
      holders.map((h) => post({ assetId: asset.id, holderId: h.id, holderType: "EMPLOYEE" }))
    );
    const statuses = results.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(14);
    expect(await prisma.allocation.count({ where: { assetId: asset.id, status: "ACTIVE" } })).toBe(1);
    const fresh = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(fresh.status).toBe("ALLOCATED");
  });

  it("returns the conflict in both the new and the legacy shape", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const asset = await createAsset();
    signInAs(admin);

    expect((await post({ assetId: asset.id, holderId: a.id })).status).toBe(201);
    const second = await post({ assetId: asset.id, holderId: b.id });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe("asset_already_allocated");
    expect(second.body.currentlyHeldBy).toBeDefined();
    expect(second.body.currently_held_by).toBeDefined();
  });

  it("the database itself rejects a second ACTIVE allocation (partial unique index)", async () => {
    const holder = await createUser();
    const asset = await createAsset();
    const data = { assetId: asset.id, holderId: holder.id, holderType: "EMPLOYEE" as const, status: "ACTIVE" as const };
    await prisma.allocation.create({ data });

    await expect(prisma.allocation.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });

  it("can allocate again after the asset is returned", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const asset = await createAsset();
    signInAs(admin);

    const first = await post({ assetId: asset.id, holderId: a.id });
    expect(first.status).toBe(201);

    const returned = await returnAsset(first.body.id, "GOOD", undefined, admin.id);
    expect(returned.success).toBe(true);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("AVAILABLE");

    expect((await post({ assetId: asset.id, holderId: b.id })).status).toBe(201);
  });

  it("allocates to a department (no individual holder)", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const dept = await createDepartment();
    const asset = await createAsset();
    signInAs(admin);

    const res = await post({ assetId: asset.id, holderType: "DEPARTMENT", holderDeptId: dept.id });

    expect(res.status).toBe(201);
    expect(res.body.holderType).toBe("DEPARTMENT");
    expect(res.body.holderDeptId).toBe(dept.id);
    expect(res.body.holderId).toBeNull();
  });

  it("rejects a missing, inactive or unknown recipient", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const inactive = await createUser({ status: "INACTIVE" });
    const asset = await createAsset();
    signInAs(admin);

    const noHolder = await post({ assetId: asset.id });
    expect(noHolder.status).toBe(400);
    expect(noHolder.body.field).toBe("holderId");

    const gone = await post({ assetId: asset.id, holderId: 999999 });
    expect(gone.status).toBe(400);
    expect(gone.body.error).toBe("invalid_recipient");

    const off = await post({ assetId: asset.id, holderId: inactive.id });
    expect(off.status).toBe(400);
    expect(off.body.error).toBe("invalid_recipient");
  });

  it("rejects a department allocation without a department", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const asset = await createAsset();
    signInAs(admin);

    const res = await post({ assetId: asset.id, holderType: "DEPARTMENT" });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("holderDeptId");
  });

  it("will not allocate an asset that is under maintenance", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const holder = await createUser();
    const asset = await createAsset({ status: "UNDER_MAINTENANCE" });
    signInAs(admin);

    const res = await post({ assetId: asset.id, holderId: holder.id });
    expect(res.status).toBe(400);
    expect(await prisma.allocation.count()).toBe(0);
  });

  it("limits a Department Head to their own department", async () => {
    const [mine, other] = await Promise.all([createDepartment("Mine"), createDepartment("Other")]);
    const head = await createUser({ role: "DEPARTMENT_HEAD", departmentId: mine.id });
    const insider = await createUser({ departmentId: mine.id });
    const outsider = await createUser({ departmentId: other.id });
    const asset = await createAsset();
    signInAs(head);

    const blocked = await post({ assetId: asset.id, holderId: outsider.id });
    expect(blocked.status).toBe(403);
    expect(await prisma.allocation.count()).toBe(0);

    expect((await post({ assetId: asset.id, holderId: insider.id })).status).toBe(201);
  });
});