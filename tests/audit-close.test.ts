import { describe, it, expect, beforeEach } from "vitest";
import { POST as closeCycle } from "@/app/api/audit-cycles/[id]/close/route";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { jsonRequest } from "./helpers/http";

const HOUR = 3_600_000;

async function close(cycleId: number) {
  const res = await closeCycle(jsonRequest(`/api/audit-cycles/${cycleId}/close`, "POST"), {
    params: Promise.resolve({ id: String(cycleId) }),
  });
  return { status: res.status, body: await res.json() };
}

async function createCycle(adminId: number) {
  return prisma.auditCycle.create({
    data: {
      name: "Q4 audit",
      scopeType: "ALL",
      startDate: new Date(),
      endDate: new Date(Date.now() + 24 * HOUR),
      createdBy: adminId,
    },
  });
}

const markMissing = (cycleId: number, assetId: number, auditorId: number) =>
  prisma.auditFinding.create({ data: { cycleId, assetId, auditorId, status: "MISSING" } });

describe("closing an audit cycle", () => {
  let admin: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    await resetDb();
    admin = await createUser({ role: "ADMIN" });
    signInAs(admin);
  });

  it("marks a missing asset LOST and closes its open allocation", async () => {
    const holder = await createUser();
    const asset = await createAsset({ status: "ALLOCATED" });
    const allocation = await prisma.allocation.create({
      data: { assetId: asset.id, holderId: holder.id, holderType: "EMPLOYEE", status: "ACTIVE" },
    });
    const cycle = await createCycle(admin.id);
    await markMissing(cycle.id, asset.id, admin.id);

    const res = await close(cycle.id);

    expect(res.status).toBe(200);
    expect(res.body.allocationsClosed).toBe(1);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("LOST");
    const after = await prisma.allocation.findUniqueOrThrow({ where: { id: allocation.id } });
    expect(after.status).toBe("RETURNED");
    expect(after.returnedDate).not.toBeNull();
    expect(await prisma.allocation.count({ where: { assetId: asset.id, status: "ACTIVE" } })).toBe(0);
  });

  it("cancels upcoming bookings of a missing resource and tells the booker", async () => {
    const booker = await createUser();
    const room = await createAsset({ isBookable: true });
    const start = new Date(Date.now() + 48 * HOUR);
    const booking = await prisma.resourceBooking.create({
      data: {
        resourceId: room.id,
        bookerId: booker.id,
        startTime: start,
        endTime: new Date(start.getTime() + HOUR),
        status: "UPCOMING",
      },
    });
    const cycle = await createCycle(admin.id);
    await markMissing(cycle.id, room.id, admin.id);

    const res = await close(cycle.id);

    expect(res.body.cancelledBookings).toBe(1);
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe("CANCELLED");
    expect(
      await prisma.notification.count({ where: { userId: booker.id, type: "booking_cancelled" } })
    ).toBe(1);
  });

  it("leaves verified assets and their allocations alone", async () => {
    const holder = await createUser();
    const asset = await createAsset({ status: "ALLOCATED" });
    await prisma.allocation.create({
      data: { assetId: asset.id, holderId: holder.id, holderType: "EMPLOYEE", status: "ACTIVE" },
    });
    const cycle = await createCycle(admin.id);
    await prisma.auditFinding.create({
      data: { cycleId: cycle.id, assetId: asset.id, auditorId: admin.id, status: "VERIFIED" },
    });

    await close(cycle.id);

    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("ALLOCATED");
    expect(await prisma.allocation.count({ where: { assetId: asset.id, status: "ACTIVE" } })).toBe(1);
  });

  it("does not turn a disposed asset into a lost one", async () => {
    const asset = await createAsset({ status: "DISPOSED" });
    const cycle = await createCycle(admin.id);
    await markMissing(cycle.id, asset.id, admin.id);

    await close(cycle.id);

    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("DISPOSED");
  });

  it("two simultaneous closes: exactly one succeeds, the other gets 409", async () => {
    const cycle = await createCycle(admin.id);

    const results = await Promise.all([close(cycle.id), close(cycle.id)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});