import { describe, it, expect, beforeEach } from "vitest";
import { POST as createAsset } from "@/app/api/assets/route";
import { nextAssetTag, syncAssetTagSequence } from "@/lib/assetTag";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createCategory } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call } from "./helpers/http";

describe("asset tags", () => {
  let categoryId: number;

  beforeEach(async () => {
    await resetDb();
    signInAs(await createUser({ role: "ADMIN" }));
    categoryId = (await createCategory()).id;
  });

  const create = () => call(createAsset, "POST", "/api/assets", { name: "Laptop", categoryId });
  const manualAsset = (assetTag: string) =>
    prisma.asset.create({ data: { assetTag, name: "Old asset", categoryId } });

  it("numbers new assets in order", async () => {
    const tags = [(await create()).body.assetTag, (await create()).body.assetTag];

    expect(tags).toEqual(["AF-0001", "AF-0002"]);
  });

  it("20 simultaneous creates all succeed, each with its own tag", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, create));

    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    expect(new Set(results.map((r) => r.body.assetTag)).size).toBe(20);
  });

  it("skips tags that already exist (assets added by hand or by the seed)", async () => {
    await manualAsset("AF-0001");
    await manualAsset("AF-0002");
    await manualAsset("AF-0003");

    const res = await create();

    expect(res.status).toBe(201);
    expect(res.body.assetTag).toBe("AF-0004");
  });

  it("compares tags as numbers, so AF-10000 comes after AF-9999", async () => {
    await manualAsset("AF-9999");
    await manualAsset("AF-10000");

    await syncAssetTagSequence();

    expect(await nextAssetTag()).toBe("AF-10001");
  });

  it("a duplicate serial number is still a 409, not a retry loop", async () => {
    await prisma.asset.create({ data: { assetTag: "X-1", name: "A", categoryId, serialNumber: "SN-1" } });

    const res = await call(createAsset, "POST", "/api/assets", { name: "B", categoryId, serialNumber: "SN-1" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("serial_taken");
  });
});
