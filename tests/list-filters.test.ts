import { describe, it, expect, beforeEach } from "vitest";
import { GET as listAssets } from "@/app/api/assets/route";
import { GET as listActivity } from "@/app/api/activity/route";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset, createCategory } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call } from "./helpers/http";

describe("server-side search and filters behind the page controls", () => {
  let admin: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    await resetDb();
    admin = await createUser({ role: "ADMIN" });
    signInAs(admin);
  });

  describe("GET /api/assets?q=", () => {
    const search = (q: string, extra = "") =>
      call(listAssets, "GET", `/api/assets?q=${encodeURIComponent(q)}${extra}`);
    const names = (res: { body: { data: { name: string }[] } }) => res.body.data.map((a) => a.name).sort();

    beforeEach(async () => {
      const categoryId = (await createCategory()).id;
      await createAsset({ categoryId, name: "Dell Laptop", location: "Engineering Floor 2" });
      await createAsset({ categoryId, name: "Projector", location: "Board Room" });
      const chair = await createAsset({ categoryId, name: "Office Chair", location: "Warehouse" });
      await prisma.asset.update({ where: { id: chair.id }, data: { serialNumber: "SN-LAPTOP-77" } });
    });

    it("matches the name, ignoring case", async () => {
      expect(names(await search("projector"))).toEqual(["Projector"]);
    });

    it("matches the location", async () => {
      expect(names(await search("board room"))).toEqual(["Projector"]);
    });

    it("matches name OR serial number in one search", async () => {
      // "laptop" is in one asset's name and in another asset's serial number.
      const res = await search("laptop");
      expect(names(res)).toEqual(["Dell Laptop", "Office Chair"]);
      expect(res.body.total).toBe(2);
    });

    it("matches the asset tag", async () => {
      const all = await call(listAssets, "GET", "/api/assets");
      const tag: string = all.body.data[0].assetTag;

      const res = await search(tag.toLowerCase());

      expect(res.body.total).toBe(1);
      expect(res.body.data[0].assetTag).toBe(tag);
    });

    it("combines with the status filter", async () => {
      const laptop = await prisma.asset.findFirstOrThrow({ where: { name: "Dell Laptop" } });
      await prisma.asset.update({ where: { id: laptop.id }, data: { status: "RETIRED" } });

      const res = await search("laptop", "&status=RETIRED");

      expect(names(res)).toEqual(["Dell Laptop"]);
    });

    it("total reflects the search, so page counts are right", async () => {
      const categoryId = (await createCategory()).id;
      for (let i = 0; i < 6; i++) await createAsset({ categoryId, name: `Monitor ${i}` });

      const res = await search("monitor", "&pageSize=4");

      expect(res.body.data).toHaveLength(4);
      expect(res.body.total).toBe(6);
    });

    it("a blank search returns everything", async () => {
      expect((await search("   ")).body.total).toBe(3);
    });

    it("no match gives an empty page, not an error", async () => {
      const res = await search("nothing-like-this");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.total).toBe(0);
    });
  });

  describe("GET /api/activity?category=", () => {
    const activity = (query = "") => call(listActivity, "GET", `/api/activity${query}`);
    const actions = (res: { body: { data: { action: string }[] } }) => res.body.data.map((l) => l.action).sort();

    beforeEach(async () => {
      for (const action of [
        "asset_allocated",
        "transfer_approved",
        "transfer_rejected",
        "maintenance_approved",
        "maintenance_rejected",
        "booking_confirmed",
        "booking_cancelled",
        "allocation_overdue",
      ]) {
        await prisma.activityLog.create({ data: { actorId: admin.id, action } });
      }
    });

    it("no category, or ALL, returns everything", async () => {
      expect((await activity()).body.total).toBe(8);
      expect((await activity("?category=ALL")).body.total).toBe(8);
    });

    it("ALERTS: rejections, cancellations and overdue returns", async () => {
      const res = await activity("?category=ALERTS");
      expect(actions(res)).toEqual([
        "allocation_overdue",
        "booking_cancelled",
        "maintenance_rejected",
        "transfer_rejected",
      ]);
      expect(res.body.total).toBe(4);
    });

    it("APPROVALS: every approved or rejected decision", async () => {
      expect(actions(await activity("?category=APPROVALS"))).toEqual([
        "maintenance_approved",
        "maintenance_rejected",
        "transfer_approved",
        "transfer_rejected",
      ]);
    });

    it("BOOKINGS: booking events only", async () => {
      expect(actions(await activity("?category=BOOKINGS"))).toEqual(["booking_cancelled", "booking_confirmed"]);
    });

    it("total follows the category, so page counts are right", async () => {
      const res = await activity("?category=ALERTS&pageSize=3");
      expect(res.body.data).toHaveLength(3);
      expect(res.body.total).toBe(4);
    });

    it("an unknown category is a 400", async () => {
      const res = await activity("?category=NOPE");
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("category");
    });

    it("an employee's category view still only counts their own entries", async () => {
      const employee = await createUser();
      await prisma.activityLog.create({ data: { actorId: employee.id, action: "booking_confirmed" } });

      signInAs(employee);
      const res = await activity("?category=BOOKINGS");

      expect(res.body.total).toBe(1);
    });
  });
});
