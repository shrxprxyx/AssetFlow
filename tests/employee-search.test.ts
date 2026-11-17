import { describe, it, expect, beforeEach } from "vitest";
import { GET as listEmployees } from "@/app/api/employees/route";
import { prisma } from "@/services/prisma";
import { resetDb, createUser } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call } from "./helpers/http";

describe("GET /api/employees?q=", () => {
  beforeEach(async () => {
    await resetDb();
    signInAs(await createUser({ role: "ADMIN" }));
    const make = (firstName: string, lastName: string, email: string) =>
      prisma.user.create({
        data: { firstName, lastName, email, passwordHash: "x", role: "EMPLOYEE", status: "ACTIVE" },
      });
    await make("Priya", "Sharma", "priya.sharma@corp.test");
    await make("Priyanka", "Rao", "priyanka@corp.test");
    await make("Arjun", "Mehta", "arjun@corp.test");
  });

  const names = async (query: string) =>
    (await call(listEmployees, "GET", `/api/employees?${query}`)).body.data
      .map((e: { firstName: string }) => e.firstName)
      .filter((n: string) => n !== "User")
      .sort();

  it("finds people by part of a first name, case-insensitively", async () => {
    expect(await names("q=PRIY")).toEqual(["Priya", "Priyanka"]);
  });

  it("finds people by last name or email", async () => {
    expect(await names("q=mehta")).toEqual(["Arjun"]);
    expect(await names("q=corp.test")).toEqual(["Arjun", "Priya", "Priyanka"]);
  });

  it("every word must match, so a full name narrows it down", async () => {
    expect(await names("q=priya sharma")).toEqual(["Priya"]);
    expect(await names("q=priya mehta")).toEqual([]);
  });

  it("ignores extra spaces, and an empty q means no filter", async () => {
    expect(await names("q=%20%20priya%20%20")).toEqual(["Priya", "Priyanka"]);
    expect((await names("q=")).length).toBeGreaterThanOrEqual(3);
  });

  it("combines with the other filters and keeps the total right", async () => {
    await prisma.user.updateMany({ where: { firstName: "Priyanka" }, data: { status: "INACTIVE" } });

    const res = await call(listEmployees, "GET", "/api/employees?q=priya&status=ACTIVE");

    expect(res.body.total).toBe(1);
    expect(res.body.data[0].firstName).toBe("Priya");
  });
});

describe("GET /api/employees?role= (one role, or several separated by commas)", () => {
  beforeEach(async () => {
    await resetDb();
    signInAs(await createUser({ role: "ADMIN" }));
    for (const [firstName, role] of [
      ["Asha", "ASSET_MANAGER"],
      ["Dev", "DEPARTMENT_HEAD"],
      ["Esha", "EMPLOYEE"],
    ] as const) {
      await prisma.user.create({
        data: { firstName, lastName: "T", email: `${firstName}@role.test`.toLowerCase(), passwordHash: "x", role, status: "ACTIVE" },
      });
    }
  });

  const roles = async (query: string) =>
    (await call(listEmployees, "GET", `/api/employees?${query}`)).body.data.map((e: { role: string }) => e.role).sort();

  it("still filters by a single role", async () => {
    expect(await roles("role=EMPLOYEE")).toEqual(["EMPLOYEE"]);
  });

  it("accepts several roles at once", async () => {
    expect(await roles("role=ADMIN,ASSET_MANAGER,DEPARTMENT_HEAD")).toEqual(["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD"]);
  });

  it("tolerates spaces and repeats in the list", async () => {
    expect(await roles("role=ASSET_MANAGER, ASSET_MANAGER ,EMPLOYEE")).toEqual(["ASSET_MANAGER", "EMPLOYEE"]);
  });

  it("refuses the whole request when one role in the list is unknown", async () => {
    for (const bad of ["ADMIN,WIZARD", "WIZARD", ",", ",,"]) {
      const res = await call(listEmployees, "GET", `/api/employees?role=${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("role");
    }
  });

  it("ignores an empty role, like no filter", async () => {
    expect((await roles("role=")).length).toBe(4);
  });

  it("combines with search and status, and reports the right total", async () => {
    const res = await call(listEmployees, "GET", "/api/employees?role=ASSET_MANAGER,DEPARTMENT_HEAD&q=asha&status=ACTIVE");

    expect(res.body.total).toBe(1);
    expect(res.body.data[0].firstName).toBe("Asha");
  });
});
