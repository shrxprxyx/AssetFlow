import { describe, it, expect } from "vitest";
import { buildHeatmap, isValidTimeZone, offsetMinutes, type Heatmap } from "@/lib/heatmap";

// Wednesday 2030-01-16 12:00 UTC. The 7-day window is Wed 9 Jan .. Tue 15 Jan (local days).
const NOW = new Date(Date.UTC(2030, 0, 16, 12, 0));
const utc = (day: number, h: number, m = 0) => new Date(Date.UTC(2030, 0, day, h, m));
const cell = (h: Heatmap, weekday: number, hour: number) => h.cells.find((c) => c.weekday === weekday && c.hour === hour)!;
const MON = 0, TUE = 1, WED = 2, THU = 3;

const build = (bookings: { startTime: Date; endTime: Date }[], over: Partial<Parameters<typeof buildHeatmap>[1]> = {}) =>
  buildHeatmap(bookings, { now: NOW, days: 7, timeZone: "UTC", resourceCount: 2, ...over });

describe("time zones", () => {
  it("knows valid and invalid zone names", () => {
    expect(isValidTimeZone("Asia/Calcutta")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
  it("finds the offset, half hours included", () => {
    expect(offsetMinutes(NOW, "UTC")).toBe(0);
    expect(offsetMinutes(NOW, "Asia/Calcutta")).toBe(330);
    expect(offsetMinutes(NOW, "America/New_York")).toBe(-300);
  });
});

describe("buildHeatmap", () => {
  it("always returns all 7 x 24 cells, empty when nothing is booked", () => {
    const h = build([]);

    expect(h.cells).toHaveLength(168);
    expect(h.totalBookedHours).toBe(0);
    expect(h.busiest).toBeNull();
    expect(h.cells.every((c) => c.bookedHours === 0 && c.utilisationPct === 0)).toBe(true);
  });

  it("uses whole local days ending yesterday", () => {
    const h = build([]);

    expect(h.from.toISOString()).toBe("2030-01-09T00:00:00.000Z");
    expect(h.to.toISOString()).toBe("2030-01-16T00:00:00.000Z");
  });

  it("puts a booking in the right weekday and hour, as a share of capacity", () => {
    // Tue 15 Jan 10:00-11:00 UTC. 2 resources x 1 Tuesday in the window = 2 resource-hours.
    const h = build([{ startTime: utc(15, 10), endTime: utc(15, 11) }]);

    expect(cell(h, TUE, 10)).toMatchObject({ bookedHours: 1, utilisationPct: 50 });
    expect(cell(h, TUE, 11).bookedHours).toBe(0);
    expect(h.busiest).toMatchObject({ weekday: TUE, hour: 10 });
  });

  it("splits a booking across the hours it covers", () => {
    // 09:30-11:15 -> 0.5 h in the 9 o'clock hour, 1 h in the 10, 0.25 h in the 11.
    const h = build([{ startTime: utc(14, 9, 30), endTime: utc(14, 11, 15) }]);

    expect([9, 10, 11].map((hr) => cell(h, MON, hr).bookedHours)).toEqual([0.5, 1, 0.25]);
    expect(h.totalBookedHours).toBe(1.75);
  });

  it("a booking that runs past midnight lands on both days", () => {
    // Mon 14 Jan 23:00 -> Tue 15 Jan 01:00
    const h = build([{ startTime: utc(14, 23), endTime: utc(15, 1) }]);

    expect(cell(h, MON, 23).bookedHours).toBe(1);
    expect(cell(h, TUE, 0).bookedHours).toBe(1);
  });

  it("adds up bookings from different resources in the same cell", () => {
    const h = build([
      { startTime: utc(15, 10), endTime: utc(15, 11) },
      { startTime: utc(15, 10), endTime: utc(15, 11) },
    ]);

    expect(cell(h, TUE, 10)).toMatchObject({ bookedHours: 2, utilisationPct: 100 });
  });

  it("divides by how many of that weekday the window holds", () => {
    // 14 days holds two of each weekday: Tuesdays 8 Jan and 15 Jan. One booking is 1 of 4 resource-hours.
    const h = build([{ startTime: utc(15, 10), endTime: utc(15, 11) }], { days: 14 });

    expect(cell(h, TUE, 10).utilisationPct).toBe(25);
  });

  it("ignores time outside the window, and today", () => {
    const h = build([
      { startTime: utc(8, 10), endTime: utc(8, 11) }, // before the window
      { startTime: utc(16, 10), endTime: utc(16, 11) }, // today
    ]);

    expect(h.totalBookedHours).toBe(0);
  });

  it("clips a booking that starts before the window", () => {
    const h = build([{ startTime: utc(8, 22), endTime: utc(9, 2) }]);

    expect(h.totalBookedHours).toBe(2); // only 00:00-02:00 on the 9th
    expect(cell(h, WED, 0).bookedHours).toBe(1);
    expect(cell(h, WED, 1).bookedHours).toBe(1);
  });

  it("reads hours in the given time zone, including half-hour offsets", () => {
    // 04:30-05:30 UTC on Tue 15 Jan is 10:00-11:00 in India.
    const h = build([{ startTime: utc(15, 4, 30), endTime: utc(15, 5, 30) }], { timeZone: "Asia/Calcutta" });

    expect(cell(h, TUE, 10).bookedHours).toBe(1);
    expect(cell(h, TUE, 4).bookedHours).toBe(0);
  });

  it("can move a booking onto the previous or next weekday", () => {
    // 20:00 UTC Mon 14 Jan is 01:30 Tue 15 Jan in India (local today is the 16th, so the 15th is in the window).
    const h = build([{ startTime: utc(14, 20), endTime: utc(14, 21) }], { timeZone: "Asia/Calcutta" });

    expect(cell(h, MON, 1).bookedHours).toBe(0);
    expect(cell(h, TUE, 1).bookedHours).toBe(0.5);
    expect(cell(h, TUE, 2).bookedHours).toBe(0.5);
  });

  it("has no capacity, so no percentages, when there are no bookable resources", () => {
    const h = build([{ startTime: utc(15, 10), endTime: utc(15, 11) }], { resourceCount: 0 });

    expect(cell(h, TUE, 10).utilisationPct).toBe(0);
  });

  it("never reports more than 100 %", () => {
    const h = build([
      { startTime: utc(15, 10), endTime: utc(15, 11) },
      { startTime: utc(15, 10), endTime: utc(15, 11) },
      { startTime: utc(15, 10), endTime: utc(15, 11) },
    ]);

    expect(cell(h, TUE, 10).utilisationPct).toBe(100);
  });

  it("handles a zone with daylight saving across the window", () => {
    // New York, 15 Mar 2030 (before DST on the 10th it is -5; after, -4). 14:00-15:00 UTC on Thu 21 Mar is 10:00 EDT.
    const now = new Date(Date.UTC(2030, 2, 25, 12, 0));
    const h = buildHeatmap([{ startTime: new Date(Date.UTC(2030, 2, 21, 14)), endTime: new Date(Date.UTC(2030, 2, 21, 15)) }], {
      now,
      days: 14,
      timeZone: "America/New_York",
      resourceCount: 1,
    });

    expect(cell(h, THU, 10).bookedHours).toBe(1);
  });
});
