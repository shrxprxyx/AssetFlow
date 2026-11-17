import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST as book } from "@/app/api/bookings/route";
import { PATCH as reschedule } from "@/app/api/bookings/[id]/route";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call, jsonRequest } from "./helpers/http";

// A fixed day far in the future, like the other booking tests.
const at = (hour: number, minute = 0) => new Date(Date.UTC(2030, 0, 15, hour, minute)).toISOString();

type Ctx = { params: Promise<{ id: string }> };
async function move(id: number, body: unknown) {
  const res = await (reschedule as (r: ReturnType<typeof jsonRequest>, c: Ctx) => Promise<Response>)(
    jsonRequest(`/api/bookings/${id}`, "PATCH", body),
    { params: Promise.resolve({ id: String(id) }) }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json };
}

describe("PATCH /api/bookings/:id (reschedule)", () => {
  let owner: Awaited<ReturnType<typeof createUser>>;
  let room: Awaited<ReturnType<typeof createAsset>>;

  beforeEach(async () => {
    await unblockEvents();
    await resetDb();
    owner = await createUser();
    room = await createAsset({ isBookable: true });
    signInAs(owner);
  });
  afterEach(unblockEvents);

  const reserve = async (start: string, end: string, resourceId = room.id) =>
    (await call(book, "POST", "/api/bookings", { resourceId, startTime: start, endTime: end })).body.booking.id as number;
  const row = (id: number) => prisma.resourceBooking.findUniqueOrThrow({ where: { id } });

  it("moves the booking to the new time", async () => {
    const id = await reserve(at(9), at(10));

    const res = await move(id, { startTime: at(14), endTime: at(15) });

    expect(res.status).toBe(200);
    expect((await row(id)).startTime.toISOString()).toBe(at(14));
    expect((await row(id)).endTime.toISOString()).toBe(at(15));
  });

  it("can overlap its own old time", async () => {
    const id = await reserve(at(9), at(11));

    expect((await move(id, { startTime: at(10), endTime: at(12) })).status).toBe(200);
  });

  it("is refused when the new time overlaps another booking, and nothing changes", async () => {
    const id = await reserve(at(9), at(10));
    await reserve(at(14), at(15));

    const res = await move(id, { startTime: at(14, 30), endTime: at(15, 30) });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("booking_overlap");
    expect((await row(id)).startTime.toISOString()).toBe(at(9));
  });

  it("allows moving next to another booking", async () => {
    const id = await reserve(at(9), at(10));
    await reserve(at(14), at(15));

    expect((await move(id, { startTime: at(15), endTime: at(16) })).status).toBe(200);
  });

  it("frees the old slot for someone else", async () => {
    const id = await reserve(at(9), at(10));
    await move(id, { startTime: at(14), endTime: at(15) });

    const other = await call(book, "POST", "/api/bookings", { resourceId: room.id, startTime: at(9), endTime: at(10) });

    expect(other.status).toBe(201);
  });

  it("changes the purpose when given, and keeps it when not", async () => {
    const id = (
      await call(book, "POST", "/api/bookings", { resourceId: room.id, startTime: at(9), endTime: at(10), purpose: "Sync" })
    ).body.booking.id as number;

    await move(id, { startTime: at(11), endTime: at(12) });
    expect((await row(id)).purpose).toBe("Sync");

    await move(id, { startTime: at(11), endTime: at(12), purpose: "Retro" });
    expect((await row(id)).purpose).toBe("Retro");
  });

  it("re-arms the reminder", async () => {
    const id = await reserve(at(9), at(10));
    await prisma.resourceBooking.update({ where: { id }, data: { reminderSent: true } });

    await move(id, { startTime: at(11), endTime: at(12) });

    expect((await row(id)).reminderSent).toBe(false);
  });

  it("only the person who booked it, or a manager, can move it", async () => {
    const id = await reserve(at(9), at(10));
    signInAs(await createUser());
    expect((await move(id, { startTime: at(11), endTime: at(12) })).status).toBe(403);

    signInAs(await createUser({ role: "ASSET_MANAGER" }));
    expect((await move(id, { startTime: at(11), endTime: at(12) })).status).toBe(200);
  });

  it("cancelled, started and finished bookings can't be moved", async () => {
    const cancelled = await reserve(at(9), at(10));
    await prisma.resourceBooking.update({ where: { id: cancelled }, data: { status: "CANCELLED" } });
    expect((await move(cancelled, { startTime: at(11), endTime: at(12) })).status).toBe(409);

    const ongoing = await reserve(at(12), at(13));
    await prisma.resourceBooking.update({ where: { id: ongoing }, data: { status: "ONGOING" } });
    expect((await move(ongoing, { startTime: at(16), endTime: at(17) })).status).toBe(409);

    // An UPCOMING row whose start time has already passed counts as started.
    const lapsed = await reserve(at(18), at(19));
    await prisma.resourceBooking.update({
      where: { id: lapsed },
      data: { startTime: new Date(Date.now() - 3_600_000), endTime: new Date(Date.now() + 3_600_000) },
    });
    expect((await move(lapsed, { startTime: at(20), endTime: at(21) })).status).toBe(409);
  });

  it("validates the new time", async () => {
    const id = await reserve(at(9), at(10));

    expect((await move(id, { startTime: at(12), endTime: at(11) })).status).toBe(400); // ends before it starts
    expect((await move(id, { startTime: "2000-01-01T10:00:00Z", endTime: "2000-01-01T11:00:00Z" })).status).toBe(400); // past
    expect((await move(id, { startTime: at(1), endTime: at(14) })).status).toBe(400); // over 12 hours
    expect((await move(id, {})).status).toBe(400);
  });

  it("is refused once the room is under maintenance", async () => {
    const id = await reserve(at(9), at(10));
    await prisma.asset.update({ where: { id: room.id }, data: { status: "UNDER_MAINTENANCE" } });

    expect((await move(id, { startTime: at(11), endTime: at(12) })).status).toBe(409);
  });

  it("an unknown booking is a 404 and a bad id a 400", async () => {
    expect((await move(999999, { startTime: at(11), endTime: at(12) })).status).toBe(404);
    expect((await move(-1, { startTime: at(11), endTime: at(12) })).status).toBe(400);
  });

  it("of many simultaneous moves into one slot, exactly one wins", async () => {
    const ids = [];
    for (let h = 0; h < 8; h++) ids.push(await reserve(at(h), at(h + 1)));

    const results = await Promise.all(ids.map((id) => move(id, { startTime: at(14), endTime: at(15) })));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
  });

  describe("event and notification", () => {
    it("records booking_rescheduled with the change, and tells the booker when a manager moved it", async () => {
      const id = await reserve(at(9), at(10));
      const manager = await createUser({ role: "ASSET_MANAGER" });
      signInAs(manager);

      await move(id, { startTime: at(14), endTime: at(15) });

      const [event] = await prisma.activityLog.findMany({ where: { action: "booking_rescheduled" } });
      expect(event.actorId).toBe(manager.id);
      expect(event.processedAt).not.toBeNull();
      expect(JSON.parse(event.changes!).from.startTime).toBe(at(9));
      expect(JSON.parse(event.changes!).to.startTime).toBe(at(14));
      const told = await prisma.notification.findMany({ where: { type: "booking_rescheduled" } });
      expect(told.map((n) => n.userId)).toEqual([owner.id]);
    });

    it("does not notify you about your own change", async () => {
      const id = await reserve(at(9), at(10));

      await move(id, { startTime: at(14), endTime: at(15) });

      expect(await prisma.notification.count({ where: { type: "booking_rescheduled" } })).toBe(0);
    });

    it("a refused move records no event", async () => {
      const id = await reserve(at(9), at(10));
      await reserve(at(14), at(15));

      await move(id, { startTime: at(14), endTime: at(15) });

      expect(await prisma.activityLog.count({ where: { action: "booking_rescheduled" } })).toBe(0);
    });

    it("the move rolls back when its event can't be recorded", async () => {
      const id = await reserve(at(9), at(10));
      await blockEvents();

      const res = await move(id, { startTime: at(14), endTime: at(15) });

      expect(res.status).toBe(500);
      expect((await row(id)).startTime.toISOString()).toBe(at(9));
    });
  });
});

const BLOCK = "activitylog_block_for_test";
const blockEvents = () =>
  prisma.$executeRawUnsafe(`ALTER TABLE "ActivityLog" ADD CONSTRAINT ${BLOCK} CHECK (false) NOT VALID`);
const unblockEvents = () => prisma.$executeRawUnsafe(`ALTER TABLE "ActivityLog" DROP CONSTRAINT IF EXISTS ${BLOCK}`);
