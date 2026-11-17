import { describe, it, expect, beforeEach } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { findUserByEmail, normalizeEmail } from "@/lib/userLookup";
import * as allocations from "@/lib/allocations";
import { allocateAsset, returnAsset } from "@/lib/allocations";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";
import { call } from "./helpers/http";

const join = (body: unknown) => call(signup, "POST", "/api/auth/signup", body);
const person = (email: string, extra: Record<string, unknown> = {}) => ({
  firstName: "Priya",
  lastName: "Shah",
  email,
  password: "a-long-password",
  ...extra,
});

describe("signup", () => {
  beforeEach(resetDb);

  it("stores the email trimmed and in lowercase", async () => {
    const res = await join(person("  Priya.Shah@Example.COM  "));

    expect(res.status).toBe(201);
    expect(res.body.email).toBe("priya.shah@example.com");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: res.body.id } })).email).toBe("priya.shah@example.com");
  });

  it("treats addresses that differ only by letter case as the same account", async () => {
    expect((await join(person("a@x.com"))).status).toBe(201);
    // Only a verified account blocks the address; an unverified one lets the owner try again (tested elsewhere).
    await prisma.user.updateMany({ data: { emailVerifiedAt: new Date() } });

    for (const again of ["a@x.com", "A@X.COM", " A@x.com "]) {
      const res = await join(person(again));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("email_taken");
    }
    expect(await prisma.user.count()).toBe(1);
  });

  it("refuses an address that matches an older account created with capital letters", async () => {
    await prisma.user.create({
      data: { email: "Legacy@X.com", passwordHash: "x", firstName: "Old", lastName: "Account", emailVerifiedAt: new Date() },
    });

    const res = await join(person("legacy@x.com"));

    expect(res.status).toBe(409);
    expect(await prisma.user.count()).toBe(1);
  });

  it("lets exactly one of many simultaneous sign-ups for the same address win", async () => {
    const results = await Promise.all(
      ["race@x.com", "RACE@x.com", "Race@X.com", "race@x.com", " race@x.com", "race@x.com", "RACE@X.COM", "race@x.com"].map((e) =>
        join(person(e))
      )
    );

    // One request creates the account. The others either lose the database race (409) or find the
    // new, still unverified account and just get a fresh link (201 without an id). Never an error, never a second account.
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(results.filter((r) => r.body?.id !== undefined)).toHaveLength(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it("always creates an Employee, whatever the request asks for", async () => {
    const res = await join(person("sneaky@x.com", { role: "ADMIN" }));

    expect(res.status).toBe(201);
    expect(res.body.role).toBe("EMPLOYEE");
  });

  it("answers bad input with a 400, not a crash", async () => {
    const broken = await signup(
      new Request("http://localhost/api/auth/signup", { method: "POST", body: "{oops" }) as never
    );
    expect(broken.status).toBe(400);

    expect((await join(person("not-an-email"))).status).toBe(400);
    expect((await join(person("ok@x.com", { password: "short" }))).status).toBe(400);
    expect((await join({})).status).toBe(400);
  });
});

describe("finding an account by email", () => {
  beforeEach(resetDb);

  it("ignores letter case and surrounding spaces", async () => {
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { email: "Priya.Shah@Example.com" } });

    for (const typed of ["priya.shah@example.com", "PRIYA.SHAH@EXAMPLE.COM", "  Priya.Shah@Example.com "]) {
      expect((await findUserByEmail(typed))?.id).toBe(user.id);
    }
    expect(await findUserByEmail("someone.else@example.com")).toBeNull();
  });

  it("normalizes addresses", () => {
    expect(normalizeEmail("  A@B.Com ")).toBe("a@b.com");
  });
});

describe("returning an asset", () => {
  beforeEach(resetDb);

  async function allocated(condition: "GOOD" | "FAIR" | "POOR" = "GOOD") {
    const [admin, holder] = await Promise.all([createUser({ role: "ADMIN" }), createUser()]);
    const asset = await createAsset();
    await prisma.asset.update({ where: { id: asset.id }, data: { condition } });
    const result = await allocateAsset(asset.id, holder.id, null, "EMPLOYEE", undefined, admin.id);
    expect(result.success).toBe(true);
    return { admin, asset, allocationId: result.allocation!.id };
  }

  it("records the condition it came back in on the asset", async () => {
    const { admin, asset, allocationId } = await allocated("GOOD");

    const result = await returnAsset(allocationId, "POOR", "screen cracked", admin.id);

    expect(result.success).toBe(true);
    const after = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(after.condition).toBe("POOR");
    expect(after.status).toBe("AVAILABLE");
  });

  it("notes the change of condition in the asset's history", async () => {
    const { admin, asset, allocationId } = await allocated("GOOD");

    await returnAsset(allocationId, "FAIR", "a few scratches", admin.id);

    const entry = await prisma.assetHistory.findFirstOrThrow({ where: { assetId: asset.id, toStatus: "AVAILABLE" } });
    expect(entry.reason).toContain("a few scratches");
    expect(entry.reason).toContain("condition GOOD → FAIR");
  });

  it("leaves the condition alone when it came back the same", async () => {
    const { admin, asset, allocationId } = await allocated("FAIR");

    await returnAsset(allocationId, "FAIR", undefined, admin.id);

    const after = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(after.condition).toBe("FAIR");
    const entry = await prisma.assetHistory.findFirstOrThrow({ where: { assetId: asset.id, toStatus: "AVAILABLE" } });
    expect(entry.reason).toBe("Returned");
  });

  it("can be improved too: a repaired asset returned in good condition", async () => {
    const { admin, asset, allocationId } = await allocated("POOR");

    await returnAsset(allocationId, "GOOD", undefined, admin.id);

    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).condition).toBe("GOOD");
  });
});

describe("transfers", () => {
  it("only go through the approval workflow: the old direct-transfer shortcut is gone", () => {
    expect("transferAsset" in allocations).toBe(false);
  });
});