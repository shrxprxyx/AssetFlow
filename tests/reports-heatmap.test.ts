import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "@/app/api/reports/heatmap/route";
import { prisma } from "@/lib/prisma";
import { getBookingHeatmap } from "@/lib/reports";
import { resetDb, createUser, createAsset } from "./helpers/db";
import { signInAs, signOut } from "./helpers/auth";
import { call } from "./helpers/http";

// Wednesday 2030-01-16 12:00 UTC; the 7-day window is 9..15 Jan.
const NOW = new Date(Date.UTC(2030, 0, 16, 12, 0));
const utc = (day: number, h: number) => new Date(Date.UTC(2030, 0, day, h));

describe("booking heatmap", () => {
  let manager: Awaited<ReturnType<typeof createUser>>;
  let room: Awaited<ReturnType<typeof createAsset>>;

  beforeEach(async () => {
    await resetDb();
    manager = await createUser({ role: "ASSET_MANAGER" });
    room = await createAsset({ isBookable: true });
    signInAs(manager);
  });

  const book = (start: Date, end: Date, status: "UPCOMING" | "CANCELLED" = "UPCOMING", resourceId = room.id) =>
    prisma.resourceBooking.create({ data: { resourceId, bookerId: manager.id, startTime: start, endTime: end, status } });
  const tue10 = (h: Awaited<ReturnType<typeof getBookingHeatmap>>) => h.cells.find((c) => c.weekday === 1 && c.hour === 10)!;

  it("counts bookings against the number of bookable resources", async () => {
    await createAsset({ isBookable: true });
    await createAsset({ isBookable: false }); // not bookable: no capacity
    await book(utc(15, 10), utc(15, 11));

    const h = await getBookingHeatmap({ days: 7, timeZone: "UTC", now: NOW });

    expect(h.resourceCount).toBe(2);
    expect(tue10(h)).toMatchObject({ bookedHours: 1, utilisationPct: 50 });
  });

  it("leaves cancelled bookings out", async () => {
    await book(utc(15, 10), utc(15, 11), "CANCELLED");

    expect(tue10(await getBookingHeatmap({ days: 7, timeZone: "UTC", now: NOW })).bookedHours).toBe(0);
  });

  it("includes a booking that started before the window but runs into it", async () => {
    await book(utc(8, 23), utc(9, 1));

    const h = await getBookingHeatmap({ days: 7, timeZone: "UTC", now: NOW });

    expect(h.totalBookedHours).toBe(1);
  });

  it("is empty, not an error, when there are no bookings or resources", async () => {
    await resetDb();

    const h = await getBookingHeatmap({ days: 30, timeZone: "UTC", now: NOW });

    expect(h.cells).toHaveLength(168);
    expect(h.busiest).toBeNull();
  });

  describe("GET /api/reports/heatmap", () => {
    it("returns the grid for a manager", async () => {
      const { status, body } = await call(GET, "GET", "/api/reports/heatmap?days=7&tz=Asia/Calcutta");

      expect(status).toBe(200);
      expect(body.cells).toHaveLength(168);
      expect(body.timeZone).toBe("Asia/Calcutta");
      expect(body.days).toBe(7);
    });

    it("defaults to 30 days in UTC", async () => {
      const { body } = await call(GET, "GET", "/api/reports/heatmap");

      expect(body).toMatchObject({ days: 30, timeZone: "UTC" });
    });

    it("rejects an unsupported window", async () => {
      for (const days of ["0", "5", "365", "abc"]) {
        const { status, body } = await call(GET, "GET", `/api/reports/heatmap?days=${days}`);
        expect(status).toBe(400);
        expect(body.field).toBe("days");
      }
    });

    it("rejects an unknown time zone", async () => {
      const { status, body } = await call(GET, "GET", "/api/reports/heatmap?tz=Mars/Olympus");

      expect(status).toBe(400);
      expect(body.field).toBe("tz");
    });

    it("is closed to employees and signed-out users", async () => {
      signInAs(await createUser({ role: "EMPLOYEE" }));
      expect((await call(GET, "GET", "/api/reports/heatmap")).status).toBe(403);

      signOut();
      expect((await call(GET, "GET", "/api/reports/heatmap")).status).toBe(401);
    });
  });
});
