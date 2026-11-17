import { describe, it, expect, beforeEach } from "vitest";
import { POST as closeCycle } from "@/app/api/audit-cycles/[id]/close/route";
import { prisma } from "@/services/prisma";
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

// A finding an Asset Manager has already approved: closing turns the asset Lost.
const markMissing = (cycleId: number, assetId: number, auditorId: number) =>
  prisma.auditFinding.create({
    data: { cycleId, assetId, auditorId, status: "MISSING", resolutionStatus: "APPROVED" },
  });

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

  it("is refused while a flagged asset still waits for a decision, and nothing changes", async () => {
    const asset = await createAsset();
    const cycle = await createCycle(admin.id);
    await prisma.auditFinding.create({
      data: { cycleId: cycle.id, assetId: asset.id, auditorId: admin.id, status: "MISSING" }, // PENDING
    });

    const res = await close(cycle.id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("unresolved_discrepancies");
    expect(res.body.openCount).toBe(1);
    expect((await prisma.auditCycle.findUniqueOrThrow({ where: { id: cycle.id } })).status).toBe("ACTIVE");
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("AVAILABLE");
  });

  it("a rejected missing finding leaves the asset as it was", async () => {
    const asset = await createAsset();
    const cycle = await createCycle(admin.id);
    await prisma.auditFinding.create({
      data: { cycleId: cycle.id, assetId: asset.id, auditorId: admin.id, status: "MISSING", resolutionStatus: "REJECTED" },
    });

    const res = await close(cycle.id);

    expect(res.status).toBe(200);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("AVAILABLE");
  });

  it("a verified finding never blocks closing", async () => {
    const asset = await createAsset();
    const cycle = await createCycle(admin.id);
    await prisma.auditFinding.create({
      data: { cycleId: cycle.id, assetId: asset.id, auditorId: admin.id, status: "VERIFIED" },
    });

    expect((await close(cycle.id)).status).toBe(200);
  });
});

describe("closing an audit cycle: events", () => {
  let admin: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    await resetDb();
    admin = await createUser({ role: "ADMIN" });
    signInAs(admin);
  });

  it("records audit_cycle_closed and booking_cancelled together with the close", async () => {
    const booker = await createUser();
    const room = await createAsset({ isBookable: true });
    await prisma.resourceBooking.create({
      data: {
        resourceId: room.id,
        bookerId: booker.id,
        startTime: new Date(Date.now() + 2 * HOUR),
        endTime: new Date(Date.now() + 3 * HOUR),
        status: "UPCOMING",
      },
    });
    const cycle = await createCycle(admin.id);
    await markMissing(cycle.id, room.id, admin.id);

    expect((await close(cycle.id)).status).toBe(200);

    const closed = await prisma.activityLog.findMany({ where: { action: "audit_cycle_closed" } });
    const cancelled = await prisma.activityLog.findMany({ where: { action: "booking_cancelled" } });
    expect(closed).toHaveLength(1);
    expect(cancelled).toHaveLength(1);
    expect([...closed, ...cancelled].every((e) => e.processedAt !== null)).toBe(true);
    // the person whose booking was cancelled was told
    expect((await prisma.notification.findMany()).map((n) => n.userId)).toContain(booker.id);
  });

  it("a refused close (undecided discrepancies) records no event", async () => {
    const asset = await createAsset();
    const cycle = await createCycle(admin.id);
    await prisma.auditFinding.create({
      data: { cycleId: cycle.id, assetId: asset.id, auditorId: admin.id, status: "MISSING", resolutionStatus: "PENDING" },
    });

    expect((await close(cycle.id)).status).toBe(409);

    expect(await prisma.activityLog.count({ where: { action: "audit_cycle_closed" } })).toBe(0);
  });
});
