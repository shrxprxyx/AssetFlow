import { describe, it, expect, beforeEach } from "vitest";
import { GET as getAsset, PATCH as patchAsset } from "@/app/api/assets/[id]/route";
import { POST as setStatus } from "@/app/api/assets/[id]/status/route";
import { POST as allocate } from "@/app/api/allocations/route";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset, createCategory } from "./helpers/db";
import { signInAs, signOut } from "./helpers/auth";
import { call, jsonRequest } from "./helpers/http";

const HOUR = 3_600_000;
const at = (hour: number) => new Date(Date.UTC(2030, 0, 15, hour));

type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: ReturnType<typeof jsonRequest>, ctx: Ctx) => Promise<Response>;

async function callWithId(handler: Handler, method: string, id: string | number, body?: unknown) {
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

const edit = (id: string | number, body: unknown) => callWithId(patchAsset, "PATCH", id, body);
const setTo = (id: string | number, status: string, reason?: string) =>
  callWithId(setStatus, "POST", id, { status, reason });

describe("asset details", () => {
  let manager: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    await resetDb();
    manager = await createUser({ role: "ASSET_MANAGER" });
    signInAs(manager);
  });

  it("returns one asset with its current holder, 404 for unknown and 400 for bad ids", async () => {
    const holder = await createUser();
    const asset = await createAsset({ status: "ALLOCATED" });
    await prisma.allocation.create({
      data: { assetId: asset.id, holderId: holder.id, holderType: "EMPLOYEE", status: "ACTIVE" },
    });

    const ok = await callWithId(getAsset as Handler, "GET", asset.id);
    expect(ok.status).toBe(200);
    expect(ok.body.currentHolder.id).toBe(holder.id);
    expect(ok.body.category.name).toBeDefined();

    expect((await callWithId(getAsset as Handler, "GET", 999999)).status).toBe(404);
    expect((await callWithId(getAsset as Handler, "GET", "abc")).status).toBe(400);
  });

  it("edits only the fields that were sent (no hidden defaults)", async () => {
    const asset = await createAsset({ name: "Old name", isBookable: true });
    await prisma.asset.update({ where: { id: asset.id }, data: { condition: "POOR", location: "Floor 2" } });

    const res = await edit(asset.id, { name: "New name" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New name");
    expect(res.body.condition).toBe("POOR");
    expect(res.body.isBookable).toBe(true);
    expect(res.body.location).toBe("Floor 2");
    expect(res.body.status).toBe("AVAILABLE");
  });

  it("clears optional fields with null or an empty string", async () => {
    const asset = await createAsset({ location: "Floor 2" });
    await prisma.asset.update({ where: { id: asset.id }, data: { serialNumber: "SN-1", notes: "n" } });

    const res = await edit(asset.id, { location: null, serialNumber: "", notes: "" });

    expect(res.status).toBe(200);
    expect(res.body.location).toBeNull();
    expect(res.body.serialNumber).toBeNull();
    expect(res.body.notes).toBeNull();
  });

  it("rejects an empty body, a bad category and a duplicate serial number", async () => {
    const [a, b] = await Promise.all([createAsset(), createAsset()]);
    await prisma.asset.update({ where: { id: a.id }, data: { serialNumber: "SN-1" } });

    expect((await edit(b.id, {})).status).toBe(400);

    const badCategory = await edit(b.id, { categoryId: 999999 });
    expect(badCategory.status).toBe(400);
    expect(badCategory.body.field).toBe("categoryId");

    const dup = await edit(b.id, { serialNumber: "SN-1" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("serial_taken");

    const category = await createCategory("Moved to");
    expect((await edit(b.id, { categoryId: category.id })).status).toBe(200);
  });

  it("does not let status be changed through the edit route", async () => {
    const asset = await createAsset();
    const res = await edit(asset.id, { status: "LOST" });
    expect(res.status).toBe(400); // nothing editable was sent
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("AVAILABLE");
  });

  it("cannot edit a disposed asset", async () => {
    const asset = await createAsset({ status: "DISPOSED" });
    const res = await edit(asset.id, { name: "Nope" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("asset_disposed");
  });

  it("will not make a room non-bookable while it has upcoming bookings", async () => {
    const booker = await createUser();
    const room = await createAsset({ isBookable: true });
    const booking = await prisma.resourceBooking.create({
      data: { resourceId: room.id, bookerId: booker.id, startTime: at(9), endTime: at(10), status: "UPCOMING" },
    });

    const blocked = await edit(room.id, { isBookable: false });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("has_upcoming_bookings");

    await prisma.resourceBooking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });
    expect((await edit(room.id, { isBookable: false })).status).toBe(200);
  });

  it("only Admins and Asset Managers can edit", async () => {
    const asset = await createAsset();

    signInAs(await createUser({ role: "EMPLOYEE" }));
    expect((await edit(asset.id, { name: "x" })).status).toBe(403);

    signInAs(await createUser({ role: "DEPARTMENT_HEAD" }));
    expect((await edit(asset.id, { name: "x" })).status).toBe(403);

    signOut();
    expect((await edit(asset.id, { name: "x" })).status).toBe(401);
  });
});

describe("asset lifecycle", () => {
  let manager: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    await resetDb();
    manager = await createUser({ role: "ASSET_MANAGER" });
    signInAs(manager);
  });

  it("walks AVAILABLE -> RETIRED -> DISPOSED and records history", async () => {
    const asset = await createAsset();

    const retired = await setTo(asset.id, "RETIRED", "End of life");
    expect(retired.status).toBe(200);
    expect(retired.body.asset.status).toBe("RETIRED");

    expect((await setTo(asset.id, "DISPOSED")).body.asset.status).toBe("DISPOSED");

    const history = await prisma.assetHistory.findMany({ where: { assetId: asset.id }, orderBy: { id: "asc" } });
    expect(history.map((h) => h.toStatus)).toEqual(["RETIRED", "DISPOSED"]);
    expect(history[0].reason).toBe("End of life");
    expect(history[0].actorId).toBe(manager.id);

    // a disposed asset is final
    for (const target of ["AVAILABLE", "LOST", "RETIRED"]) {
      expect((await setTo(asset.id, target)).status).toBe(409);
    }
  });

  it("cannot retire an asset that is allocated or under maintenance, or dispose one that isn't retired", async () => {
    const allocated = await createAsset({ status: "ALLOCATED" });
    const maintenance = await createAsset({ status: "UNDER_MAINTENANCE" });
    const available = await createAsset();

    expect((await setTo(allocated.id, "RETIRED")).body.error).toBe("invalid_transition");
    expect((await setTo(maintenance.id, "RETIRED")).body.error).toBe("invalid_transition");
    expect((await setTo(available.id, "DISPOSED")).body.error).toBe("invalid_transition");
  });

  it("only accepts the four lifecycle targets", async () => {
    const asset = await createAsset();
    expect((await setTo(asset.id, "ALLOCATED")).status).toBe(400);
    expect((await setTo(asset.id, "UNDER_MAINTENANCE")).status).toBe(400);
    expect((await setTo(asset.id, "nonsense")).status).toBe(400);
    expect((await setTo(999999, "LOST")).status).toBe(404);
    expect((await setTo("abc", "LOST")).status).toBe(400);
  });

  it("marking an allocated asset lost closes the allocation", async () => {
    const holder = await createUser();
    const asset = await createAsset({ status: "ALLOCATED" });
    await prisma.allocation.create({
      data: { assetId: asset.id, holderId: holder.id, holderType: "EMPLOYEE", status: "ACTIVE" },
    });

    const res = await setTo(asset.id, "LOST", "Left on a train");
    expect(res.status).toBe(200);
    expect(res.body.asset.status).toBe("LOST");

    const allocation = await prisma.allocation.findFirstOrThrow({ where: { assetId: asset.id } });
    expect(allocation.status).toBe("RETURNED");
    expect(allocation.returnedDate).not.toBeNull();
  });

  it("a lost asset can be found again", async () => {
    const asset = await createAsset({ status: "LOST" });

    const res = await setTo(asset.id, "AVAILABLE");

    expect(res.status).toBe(200);
    expect(res.body.asset.status).toBe("AVAILABLE");
  });

  it("finding a lost asset that is still allocated puts it back to ALLOCATED", async () => {
    // The audit "close" step can mark an asset lost without closing its allocation.
    const holder = await createUser();
    const asset = await createAsset({ status: "LOST" });
    await prisma.allocation.create({
      data: { assetId: asset.id, holderId: holder.id, holderType: "EMPLOYEE", status: "ACTIVE" },
    });

    const res = await setTo(asset.id, "AVAILABLE");

    expect(res.body.asset.status).toBe("ALLOCATED");
  });

  it("retiring or losing an asset cancels upcoming bookings and tells the bookers", async () => {
    const booker = await createUser();
    const room = await createAsset({ isBookable: true });
    const future = await prisma.resourceBooking.create({
      data: { resourceId: room.id, bookerId: booker.id, startTime: at(9), endTime: at(10), status: "UPCOMING" },
    });
    const ended = await prisma.resourceBooking.create({
      data: {
        resourceId: room.id,
        bookerId: booker.id,
        startTime: new Date(Date.now() - 3 * HOUR),
        endTime: new Date(Date.now() - 2 * HOUR),
        status: "UPCOMING",
      },
    });

    const res = await setTo(room.id, "RETIRED");

    expect(res.status).toBe(200);
    expect(res.body.cancelledBookings).toBe(1);
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: future.id } })).status).toBe("CANCELLED");
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: ended.id } })).status).toBe("UPCOMING");

    const told = await prisma.notification.findMany({ where: { type: "booking_cancelled" } });
    expect(told.map((n) => n.userId)).toEqual([booker.id]);
  });

  it("lets exactly one of many simultaneous retire requests win", async () => {
    const asset = await createAsset();

    const results = await Promise.all(Array.from({ length: 10 }, () => setTo(asset.id, "RETIRED")));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await prisma.assetHistory.count({ where: { assetId: asset.id, toStatus: "RETIRED" } })).toBe(1);
  });

  it("a retired or lost asset can no longer be allocated", async () => {
    const holder = await createUser();
    const asset = await createAsset();
    await setTo(asset.id, "RETIRED");

    const res = await call(allocate, "POST", "/api/allocations", { assetId: asset.id, holderId: holder.id });

    expect(res.status).toBe(400);
    expect(await prisma.allocation.count()).toBe(0);
  });

  it("only Admins and Asset Managers can change status", async () => {
    const asset = await createAsset();

    signInAs(await createUser({ role: "EMPLOYEE" }));
    expect((await setTo(asset.id, "LOST")).status).toBe(403);

    signOut();
    expect((await setTo(asset.id, "LOST")).status).toBe(401);

    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("AVAILABLE");
  });
});