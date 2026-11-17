import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("@/services/mailer", () => ({
  deliverEmail: vi.fn(async () => undefined),
  sendMail: vi.fn(async () => undefined),
}));

import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as resetPasswordRoute } from "@/app/api/auth/reset-password/route";
import { POST as signOutEverywhere } from "@/app/api/account/sign-out-everywhere/route";
import { runOverdueSweep, runBookingTick } from "@/services/sweeps";
import { deliverEmail } from "@/services/mailer";
import { prisma } from "@/services/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";
import { signInAs } from "./helpers/auth";
import { call } from "./helpers/http";

// The last writers that recorded their audit entry after committing. Each change and its
// entry now commit together or not at all (same guarantee as outbox-atomic.test.ts).

const BLOCK = "activitylog_block_for_test";
const blockEvents = () =>
  prisma.$executeRawUnsafe(`ALTER TABLE "ActivityLog" ADD CONSTRAINT ${BLOCK} CHECK (false) NOT VALID`);
const unblockEvents = () => prisma.$executeRawUnsafe(`ALTER TABLE "ActivityLog" DROP CONSTRAINT IF EXISTS ${BLOCK}`);
const count = (action: string) => prisma.activityLog.count({ where: { action } });

const NOW = new Date(Date.UTC(2030, 0, 15, 12, 0));
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("audit entries commit with the change", () => {
  beforeEach(async () => {
    await unblockEvents();
    await resetDb();
    vi.mocked(deliverEmail).mockClear();
  });
  afterEach(unblockEvents);

  describe("password reset", () => {
    const account = async () =>
      prisma.user.create({
        data: { email: "priya@example.com", passwordHash: await bcrypt.hash("old-password-1", 4), firstName: "Priya", lastName: "S", emailVerifiedAt: new Date() },
      });
    const lastToken = () => /\/reset-password\?token=([\w-]+)/.exec(vi.mocked(deliverEmail).mock.calls.at(-1)![0].text)![1];

    it("asking for a link: no event means no token and no email", async () => {
      await account();
      await blockEvents();

      const res = await call(forgotPassword, "POST", "/api/auth/forgot-password", { email: "priya@example.com" });

      expect(res.status).toBe(200); // the same generic answer, so nothing leaks
      expect(await prisma.passwordResetToken.count()).toBe(0);
      expect(deliverEmail).not.toHaveBeenCalled();
    });

    it("choosing a new password: no event means the password and the link are untouched", async () => {
      const user = await account();
      await call(forgotPassword, "POST", "/api/auth/forgot-password", { email: "priya@example.com" });
      const token = lastToken();
      await blockEvents();

      const res = await call(resetPasswordRoute, "POST", "/api/auth/reset-password", { token, password: "a-new-password-1" });

      expect(res.status).toBe(500);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(await bcrypt.compare("old-password-1", after.passwordHash)).toBe(true);
      expect(after.sessionVersion).toBe(user.sessionVersion);
      expect((await prisma.passwordResetToken.findFirstOrThrow()).usedAt).toBeNull();

      // Once the log works again, the same link still does the job.
      await unblockEvents();
      expect((await call(resetPasswordRoute, "POST", "/api/auth/reset-password", { token, password: "a-new-password-1" })).status).toBe(200);
      expect(await count("password_reset_completed")).toBe(1);
    });
  });

  describe("sign out everywhere", () => {
    it("no event means the sessions are not ended", async () => {
      const user = await createUser({ role: "ASSET_MANAGER" });
      signInAs(user);
      await blockEvents();

      // The route doesn't catch it, so Next.js would answer 500.
      await expect(call(signOutEverywhere as never, "POST", "/api/account/sign-out-everywhere")).rejects.toThrow();

      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion).toBe(user.sessionVersion);
    });
  });

  describe("overdue sweep", () => {
    async function overdueAllocation() {
      const holder = await createUser();
      const asset = await createAsset({ status: "ALLOCATED" });
      return prisma.allocation.create({
        data: { assetId: asset.id, holderId: holder.id, holderType: "EMPLOYEE", expectedReturnDate: new Date(NOW.getTime() - DAY) },
      });
    }

    it("two sweeps at once record the reminder once", async () => {
      const allocation = await overdueAllocation();

      const results = await Promise.all([runOverdueSweep(NOW), runOverdueSweep(NOW), runOverdueSweep(NOW)]);

      expect(await count("allocation_overdue")).toBe(1);
      expect(results.reduce((sum, r) => sum + r.flagged, 0)).toBe(1);
      expect((await prisma.activityLog.findFirstOrThrow({ where: { action: "allocation_overdue" } })).resourceId).toBe(allocation.id);
    });

    it("an allocation that is no longer out is not flagged", async () => {
      const allocation = await overdueAllocation();
      await prisma.allocation.update({ where: { id: allocation.id }, data: { status: "RETURNED" } });

      await runOverdueSweep(NOW);

      expect(await count("allocation_overdue")).toBe(0);
    });

    it("still flags each overdue allocation exactly once across repeated sweeps", async () => {
      await overdueAllocation();
      await overdueAllocation();

      await runOverdueSweep(NOW);
      await runOverdueSweep(NOW);

      expect(await count("allocation_overdue")).toBe(2);
    });
  });

  describe("booking reminder", () => {
    async function soonBooking() {
      const resource = await createAsset({ isBookable: true });
      const booker = await createUser();
      return prisma.resourceBooking.create({
        data: { resourceId: resource.id, bookerId: booker.id, startTime: new Date(NOW.getTime() + 10 * MIN), endTime: new Date(NOW.getTime() + 70 * MIN) },
      });
    }

    it("a reminder that can't be recorded is not lost: the next tick sends it", async () => {
      const booking = await soonBooking();
      await blockEvents();

      await expect(runBookingTick(NOW)).rejects.toThrow();
      expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).reminderSent).toBe(false);

      await unblockEvents();
      const tick = await runBookingTick(NOW);

      expect(tick.reminded).toBe(1);
      expect(await count("booking_reminder")).toBe(1);
      expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).reminderSent).toBe(true);
    });

    it("two ticks at once send one reminder", async () => {
      await soonBooking();

      const ticks = await Promise.all([runBookingTick(NOW), runBookingTick(NOW)]);

      expect(ticks.reduce((sum, t) => sum + t.reminded, 0)).toBe(1);
      expect(await count("booking_reminder")).toBe(1);
    });
  });
});
