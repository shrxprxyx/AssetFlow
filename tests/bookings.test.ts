import { describe, it, expect, beforeEach } from "vitest";
import { POST as book } from "@/app/api/bookings/route";
import { cancelBooking } from "@/lib/bookings";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call } from "./helpers/http";

// A fixed day far in the future, so "past date" rules (added later) can't affect these tests.
const at = (hour: number, minute = 0) => new Date(Date.UTC(2030, 0, 15, hour, minute)).toISOString();
const reserve = (resourceId: number, start: string, end: string) =>
  call(book, "POST", "/api/bookings", { resourceId, startTime: start, endTime: end });

describe("POST /api/bookings", () => {
  beforeEach(resetDb);

  it("lets exactly one of many simultaneous bookings for the same slot win", async () => {
    const user = await createUser();
    const room = await createAsset({ isBookable: true });
    signInAs(user);

    const results = await Promise.all(
      Array.from({ length: 15 }, () => reserve(room.id, at(9), at(10)))
    );
    const statuses = results.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(14);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error === "booking_overlap")).toBe(true);
    expect(await prisma.resourceBooking.count({ where: { resourceId: room.id } })).toBe(1);
  });

  it("allows back-to-back slots", async () => {
    const user = await createUser();
    const room = await createAsset({ isBookable: true });
    signInAs(user);

    expect((await reserve(room.id, at(9), at(10))).status).toBe(201);
    expect((await reserve(room.id, at(10), at(11))).status).toBe(201);
    expect((await reserve(room.id, at(8), at(9))).status).toBe(201);
  });

  it("rejects any overlap", async () => {
    const user = await createUser();
    const room = await createAsset({ isBookable: true });
    signInAs(user);
    await reserve(room.id, at(9), at(10));

    expect((await reserve(room.id, at(9, 30), at(10, 30))).status).toBe(409); // overlaps the end
    expect((await reserve(room.id, at(8, 30), at(9, 30))).status).toBe(409);  // overlaps the start
    expect((await reserve(room.id, at(9, 15), at(9, 45))).status).toBe(409);  // inside
    expect((await reserve(room.id, at(8), at(11))).status).toBe(409);         // wraps it
  });

  it("frees the slot when a booking is cancelled", async () => {
    const user = await createUser();
    const room = await createAsset({ isBookable: true });
    signInAs(user);

    const first = await reserve(room.id, at(9), at(10));
    expect(first.status).toBe(201);
    await cancelBooking(first.body.booking.id);

    expect((await reserve(room.id, at(9), at(10))).status).toBe(201);
  });

  it("only books different resources independently", async () => {
    const user = await createUser();
    const [a, b] = await Promise.all([createAsset({ isBookable: true }), createAsset({ isBookable: true })]);
    signInAs(user);

    expect((await reserve(a.id, at(9), at(10))).status).toBe(201);
    expect((await reserve(b.id, at(9), at(10))).status).toBe(201);
  });

  it("rejects assets that are not bookable, and unknown resources", async () => {
    const user = await createUser();
    const desk = await createAsset({ isBookable: false });
    signInAs(user);

    const notBookable = await reserve(desk.id, at(9), at(10));
    expect(notBookable.status).toBe(400);
    expect(notBookable.body.error).toBe("not_bookable");

    expect((await reserve(999999, at(9), at(10))).status).toBe(404);
  });

  it("rejects an end time that is not after the start time", async () => {
    const user = await createUser();
    const room = await createAsset({ isBookable: true });
    signInAs(user);

    const res = await reserve(room.id, at(10), at(9));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("the database itself rejects overlapping rows (exclusion constraint)", async () => {
    const user = await createUser();
    const room = await createAsset({ isBookable: true });
    const row = (s: string, e: string) => ({
      resourceId: room.id,
      bookerId: user.id,
      startTime: new Date(s),
      endTime: new Date(e),
    });
    await prisma.resourceBooking.create({ data: row(at(9), at(10)) });

    await expect(prisma.resourceBooking.create({ data: row(at(9, 30), at(10, 30)) })).rejects.toThrow();
    // adjacent is fine
    await expect(prisma.resourceBooking.create({ data: row(at(10), at(11)) })).resolves.toBeDefined();
  });
});