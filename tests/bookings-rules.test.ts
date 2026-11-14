import { describe, it, expect, beforeEach } from "vitest";
import { POST as book, GET as listBookings } from "@/app/api/bookings/route";
import { DELETE as cancel } from "@/app/api/bookings/[id]/route";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";
import { signInAs, signOut } from "./helpers/auth";
import { call, jsonRequest } from "./helpers/http";

const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
const at = (hour: number) => new Date(Date.UTC(2030, 0, 15, hour)).toISOString();

const reserve = (resourceId: number, start: string, end: string) =>
  call(book, "POST", "/api/bookings", { resourceId, startTime: start, endTime: end });

async function cancelAs(id: string | number) {
  const res = await cancel(jsonRequest(`/api/bookings/${id}`, "DELETE"), {
    params: Promise.resolve({ id: String(id) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

describe("booking rules", () => {
  beforeEach(resetDb);

  it("rejects a start time in the past", async () => {
    const user = await createUser();
    const room = await createAsset({ isBookable: true });
    signInAs(user);

    const res = await reserve(room.id, inHours(-3), inHours(-2));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("startTime");
    expect(await prisma.resourceBooking.count()).toBe(0);
  });

  it("rejects bookings longer than 12 hours but accepts exactly 12", async () => {
    const user = await createUser();
    const room = await createAsset({ isBookable: true });
    signInAs(user);

    const tooLong = await reserve(room.id, inHours(24), inHours(24 + 12.5));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.field).toBe("endTime");

    const twelve = await reserve(room.id, inHours(24), inHours(24 + 12));
    expect(twelve.status).toBe(201);
  });

  it("refuses resources that are in maintenance, lost, retired or disposed", async () => {
    const user = await createUser();
    signInAs(user);

    for (const status of ["UNDER_MAINTENANCE", "LOST", "RETIRED", "DISPOSED"] as const) {
      const room = await createAsset({ isBookable: true, status });
      const res = await reserve(room.id, at(9), at(10));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("resource_unavailable");
    }
    expect(await prisma.resourceBooking.count()).toBe(0);
  });

  it("lists a day's bookings and rejects bad query parameters", async () => {
    const user = await createUser();
    const room = await createAsset({ isBookable: true });
    signInAs(user);
    await reserve(room.id, at(9), at(10));

    const ok = await call(listBookings, "GET", `/api/bookings?resourceId=${room.id}&date=2030-01-15`);
    expect(ok.status).toBe(200);
    expect(ok.body.bookings).toHaveLength(1);

    expect((await call(listBookings, "GET", `/api/bookings?resourceId=${room.id}&date=garbage`)).status).toBe(400);
    expect((await call(listBookings, "GET", "/api/bookings?date=2030-01-15")).status).toBe(400);
  });
});

describe("cancelling a booking", () => {
  beforeEach(resetDb);

  async function makeBooking(bookerId: number, resourceId: number, hour = 9) {
    return prisma.resourceBooking.create({
      data: {
        resourceId,
        bookerId,
        startTime: new Date(at(hour)),
        endTime: new Date(at(hour + 1)),
        status: "UPCOMING",
      },
    });
  }

  it("lets the person who booked cancel, and frees the slot", async () => {
    const owner = await createUser();
    const room = await createAsset({ isBookable: true });
    const booking = await makeBooking(owner.id, room.id);
    signInAs(owner);

    const res = await cancelAs(booking.id);
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("CANCELLED");

    expect((await reserve(room.id, at(9), at(10))).status).toBe(201);
  });

  it("does not let another employee cancel it", async () => {
    const [owner, other] = await Promise.all([createUser(), createUser()]);
    const room = await createAsset({ isBookable: true });
    const booking = await makeBooking(owner.id, room.id);
    signInAs(other);

    const res = await cancelAs(booking.id);
    expect(res.status).toBe(403);
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe("UPCOMING");
  });

  it("lets an Asset Manager cancel anyone's booking and tells the booker", async () => {
    const owner = await createUser();
    const manager = await createUser({ role: "ASSET_MANAGER" });
    const room = await createAsset({ isBookable: true });
    const booking = await makeBooking(owner.id, room.id);
    signInAs(manager);

    expect((await cancelAs(booking.id)).status).toBe(200);

    const told = await prisma.notification.findMany({ where: { type: "booking_cancelled" } });
    expect(told.map((n) => n.userId)).toEqual([owner.id]);
  });

  it("does not notify people about cancelling their own booking", async () => {
    const owner = await createUser();
    const room = await createAsset({ isBookable: true });
    const booking = await makeBooking(owner.id, room.id);
    signInAs(owner);

    await cancelAs(booking.id);
    expect(await prisma.notification.count({ where: { type: "booking_cancelled" } })).toBe(0);
  });

  it("answers 409 when it is already cancelled, 404 for unknown ids and 400 for bad ids", async () => {
    const owner = await createUser();
    const room = await createAsset({ isBookable: true });
    const booking = await makeBooking(owner.id, room.id);
    signInAs(owner);

    expect((await cancelAs(booking.id)).status).toBe(200);
    const again = await cancelAs(booking.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_cancelled");

    expect((await cancelAs(999999)).status).toBe(404);
    expect((await cancelAs("abc")).status).toBe(400);
  });

  it("lets exactly one of many simultaneous cancellations succeed", async () => {
    const owner = await createUser();
    const room = await createAsset({ isBookable: true });
    const booking = await makeBooking(owner.id, room.id);
    signInAs(owner);

    const results = await Promise.all(Array.from({ length: 8 }, () => cancelAs(booking.id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
  });

  it("cannot cancel a booking that has already ended", async () => {
    const owner = await createUser();
    const room = await createAsset({ isBookable: true });
    const past = await prisma.resourceBooking.create({
      data: {
        resourceId: room.id,
        bookerId: owner.id,
        startTime: new Date(Date.now() - 3 * HOUR),
        endTime: new Date(Date.now() - 2 * HOUR),
        status: "UPCOMING",
      },
    });
    signInAs(owner);

    const res = await cancelAs(past.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("booking_finished");
  });

  it("401 when nobody is signed in", async () => {
    const owner = await createUser();
    const room = await createAsset({ isBookable: true });
    const booking = await makeBooking(owner.id, room.id);
    signOut();

    expect((await cancelAs(booking.id)).status).toBe(401);
  });
});