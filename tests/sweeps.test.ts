import { describe, it, expect, beforeEach } from "vitest";
import { runOverdueSweep, runBookingTick } from "@/services/sweeps";
import { cancelBookingAs } from "@/services/bookings";
import { changeAssetStatus } from "@/services/assetLifecycle";
import { prisma } from "@/services/prisma";
import { resetDb, createUser, createAsset, createDepartment } from "./helpers/db";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("overdue sweep", () => {
  const now = new Date(Date.UTC(2030, 0, 15, 12, 0));
  let manager: Awaited<ReturnType<typeof createUser>>;
  let holder: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    await resetDb();
    manager = await createUser({ role: "ASSET_MANAGER" });
    holder = await createUser();
  });

  async function allocate(opts: { due?: Date | null; holderId?: number | null; deptId?: number; status?: "ACTIVE" | "RETURNED" }) {
    const asset = await createAsset({ status: "ALLOCATED" });
    return prisma.allocation.create({
      data: {
        assetId: asset.id,
        holderId: opts.holderId === undefined ? holder.id : opts.holderId,
        holderDeptId: opts.deptId,
        holderType: opts.deptId ? "DEPARTMENT" : "EMPLOYEE",
        expectedReturnDate: opts.due === undefined ? new Date(now.getTime() - DAY) : opts.due,
        status: opts.status ?? "ACTIVE",
      },
    });
  }

  it("flags an overdue allocation and tells the holder and the managers", async () => {
    const overdue = await allocate({});

    const result = await runOverdueSweep(now);

    expect(result).toEqual({ overdue: 1, flagged: 1 });
    const notes = await prisma.notification.findMany({ where: { type: "allocation_overdue" } });
    expect(notes.map((n) => n.userId).sort()).toEqual([holder.id, manager.id].sort());
    expect(notes.every((n) => n.relatedResourceId === overdue.id)).toBe(true);
    // it stays ACTIVE, so the one-holder-per-asset rule keeps protecting the asset
    expect((await prisma.allocation.findUniqueOrThrow({ where: { id: overdue.id } })).status).toBe("ACTIVE");
  });

  it("only ever flags an allocation once", async () => {
    await allocate({});

    await runOverdueSweep(now);
    const second = await runOverdueSweep(new Date(now.getTime() + 5 * MIN));
    const third = await runOverdueSweep(new Date(now.getTime() + 10 * MIN));

    expect(second).toEqual({ overdue: 1, flagged: 0 });
    expect(third.flagged).toBe(0);
    expect(await prisma.notification.count({ where: { type: "allocation_overdue" } })).toBe(2);
  });

  it("ignores allocations that are not due yet, have no due date, or were returned", async () => {
    await allocate({ due: new Date(now.getTime() + DAY) });
    await allocate({ due: null });
    await allocate({ status: "RETURNED" });

    expect(await runOverdueSweep(now)).toEqual({ overdue: 0, flagged: 0 });
    expect(await prisma.notification.count()).toBe(0);
  });

  it("tells only the managers when a department is the holder", async () => {
    const dept = await createDepartment();
    await allocate({ holderId: null, deptId: dept.id });

    const result = await runOverdueSweep(now);

    expect(result.flagged).toBe(1);
    const notes = await prisma.notification.findMany({ where: { type: "allocation_overdue" } });
    expect(notes.map((n) => n.userId)).toEqual([manager.id]);
  });
});

describe("booking tick", () => {
  const now = new Date(Date.UTC(2030, 0, 15, 12, 0));
  let booker: Awaited<ReturnType<typeof createUser>>;
  let roomId: number;

  beforeEach(async () => {
    await resetDb();
    booker = await createUser();
    roomId = (await createAsset({ isBookable: true })).id;
  });

  const book = (startMin: number, endMin: number, status: "UPCOMING" | "CANCELLED" = "UPCOMING") =>
    prisma.resourceBooking.create({
      data: {
        resourceId: roomId,
        bookerId: booker.id,
        startTime: new Date(now.getTime() + startMin * MIN),
        endTime: new Date(now.getTime() + endMin * MIN),
        status,
      },
    });
  const statusOf = async (id: number) =>
    (await prisma.resourceBooking.findUniqueOrThrow({ where: { id } })).status;

  it("moves bookings through UPCOMING -> ONGOING -> COMPLETED", async () => {
    const future = await book(120, 180);
    const running = await book(-30, 30);
    const finished = await book(-120, -60);

    const result = await runBookingTick(now);

    expect(await statusOf(future.id)).toBe("UPCOMING");
    expect(await statusOf(running.id)).toBe("ONGOING");
    expect(await statusOf(finished.id)).toBe("COMPLETED");
    expect(result.started).toBe(1);
    expect(result.completed).toBe(1);

    // later, the running one ends
    await runBookingTick(new Date(now.getTime() + 45 * MIN));
    expect(await statusOf(running.id)).toBe("COMPLETED");
  });

  it("never touches cancelled bookings", async () => {
    const cancelled = await book(-30, 30, "CANCELLED");
    const cancelledPast = await book(-300, -240, "CANCELLED");

    await runBookingTick(now);

    expect(await statusOf(cancelled.id)).toBe("CANCELLED");
    expect(await statusOf(cancelledPast.id)).toBe("CANCELLED");
  });

  it("reminds the booker once, shortly before the booking starts", async () => {
    const soon = await book(10, 70);
    const later = await book(120, 180);

    const first = await runBookingTick(now);
    const second = await runBookingTick(new Date(now.getTime() + 2 * MIN));

    expect(first.reminded).toBe(1);
    expect(second.reminded).toBe(0);
    const notes = await prisma.notification.findMany({ where: { type: "booking_reminder" } });
    expect(notes).toHaveLength(1);
    expect(notes[0].userId).toBe(booker.id);
    expect(notes[0].relatedResourceId).toBe(soon.id);
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: later.id } })).reminderSent).toBe(false);
  });

  it("does not remind about cancelled bookings or ones that already started", async () => {
    await book(10, 70, "CANCELLED");
    await book(-5, 55); // already started

    const result = await runBookingTick(now);

    expect(result.reminded).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it("two overlapping ticks can't send the same reminder twice", async () => {
    await book(10, 70);

    const results = await Promise.all(Array.from({ length: 5 }, () => runBookingTick(now)));

    expect(results.reduce((sum, r) => sum + r.reminded, 0)).toBe(1);
    expect(await prisma.notification.count({ where: { type: "booking_reminder" } })).toBe(1);
  });
});

describe("in-progress bookings", () => {
  beforeEach(resetDb);

  async function ongoingBooking() {
    const booker = await createUser();
    const room = await createAsset({ isBookable: true });
    const booking = await prisma.resourceBooking.create({
      data: {
        resourceId: room.id,
        bookerId: booker.id,
        startTime: new Date(Date.now() - 30 * MIN),
        endTime: new Date(Date.now() + 30 * MIN),
        status: "ONGOING",
      },
    });
    return { booker, room, booking };
  }

  it("can be cancelled to free the room early", async () => {
    const { booker, booking } = await ongoingBooking();

    const result = await cancelBookingAs({ userId: booker.id, role: "EMPLOYEE" }, booking.id);

    expect(result.status).toBe("CANCELLED");
  });

  it("cannot be cancelled once completed", async () => {
    const { booker, booking } = await ongoingBooking();
    await prisma.resourceBooking.update({ where: { id: booking.id }, data: { status: "COMPLETED" } });

    await expect(
      cancelBookingAs({ userId: booker.id, role: "EMPLOYEE" }, booking.id)
    ).rejects.toMatchObject({ status: 409, body: { error: "booking_finished" } });
  });

  it("are cancelled when the room is retired", async () => {
    const { room, booking } = await ongoingBooking();
    const manager = await createUser({ role: "ASSET_MANAGER" });

    const result = await changeAssetStatus(room.id, "RETIRED", manager.id);

    expect(result.cancelledBookingIds).toEqual([booking.id]);
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe("CANCELLED");
  });
});