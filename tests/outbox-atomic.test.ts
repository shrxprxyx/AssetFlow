import { describe, it, expect, beforeEach } from "vitest";
import { allocateAsset, returnAsset } from "@/lib/allocations";
import { createBooking, cancelBookingAs } from "@/lib/bookings";
import { createTransferRequest, approveTransfer } from "@/lib/transfers";
import {
  approveMaintenanceRequest,
  assignTechnician,
  startMaintenanceRequest,
  resolveMaintenanceRequest,
} from "@/lib/maintenance";
import { prisma } from "@/lib/prisma";
import { resetDb, createUser, createAsset } from "./helpers/db";

// Inline mode (tests): dispatchActivity() processes the event straight away, so
// after each call the row exists AND is processed AND the notification exists.

const HOUR = 3_600_000;
const soon = (hours: number) => new Date(Date.now() + hours * HOUR);

const events = (action: string) => prisma.activityLog.findMany({ where: { action } });
const allEvents = () => prisma.activityLog.count();

type User = Awaited<ReturnType<typeof createUser>>;
const actorOf = (u: User) => ({ userId: u.id, role: u.role, departmentId: u.departmentId });

describe("events are committed with the change they describe", () => {
  let admin: User;
  let holder: User;
  let other: User;

  beforeEach(async () => {
    await resetDb();
    admin = await createUser({ role: "ADMIN" });
    holder = await createUser();
    other = await createUser();
  });

  describe("allocate and return", () => {
    const allocate = (assetId: number, activity?: Parameters<typeof allocateAsset>[6]) =>
      allocateAsset(assetId, holder.id, null, "EMPLOYEE", undefined, admin.id, activity);

    it("allocating records asset_allocated, processed, and notifies the holder", async () => {
      const asset = await createAsset();

      const result = await allocate(asset.id, {
        action: "asset_allocated",
        actorId: admin.id,
        resourceType: "Asset",
        resourceId: asset.id,
        changes: { holderId: holder.id },
      });

      expect(result.success).toBe(true);
      const rows = await events("asset_allocated");
      expect(rows).toHaveLength(1);
      expect(rows[0].processedAt).not.toBeNull();
      expect((await prisma.notification.findMany()).map((n) => n.userId)).toEqual([holder.id]);
    });

    it("a failed allocation records no event", async () => {
      const asset = await createAsset({ status: "RETIRED" });
      const result = await allocate(asset.id, { action: "asset_allocated", actorId: admin.id });
      expect(result.success).toBe(false);
      expect(await allEvents()).toBe(0);
    });

    it("an event that cannot be recorded rolls the allocation back", async () => {
      const asset = await createAsset();

      const result = await allocate(asset.id, () => {
        throw new Error("cannot record");
      });

      expect(result.success).toBe(false);
      expect(await prisma.allocation.count()).toBe(0);
      expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("AVAILABLE");
    });

    it("returning records asset_returned", async () => {
      const asset = await createAsset();
      const allocated = await allocate(asset.id);
      expect(await allEvents()).toBe(0); // no activity asked for, none recorded

      const result = await returnAsset(allocated.allocation!.id, "GOOD", undefined, admin.id, {
        action: "asset_returned",
        actorId: admin.id,
        resourceType: "Allocation",
        resourceId: allocated.allocation!.id,
        changes: { condition: "GOOD" },
      });

      expect(result.success).toBe(true);
      const rows = await events("asset_returned");
      expect(rows).toHaveLength(1);
      expect(rows[0].processedAt).not.toBeNull();
    });
  });

  describe("bookings", () => {
    it("creating records booking_confirmed with the new booking's id", async () => {
      const room = await createAsset({ isBookable: true });

      const booking = await createBooking(room.id, holder.id, soon(2), soon(3), undefined, (b) => ({
        action: "booking_confirmed",
        actorId: holder.id,
        resourceType: "ResourceBooking",
        resourceId: b.id,
      }));

      const rows = await events("booking_confirmed");
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceId).toBe(booking.id);
      expect(rows[0].processedAt).not.toBeNull();
    });

    it("an overlapping booking records no event", async () => {
      const room = await createAsset({ isBookable: true });
      const spec = (b: { id: number }) => ({
        action: "booking_confirmed",
        actorId: holder.id,
        resourceType: "ResourceBooking",
        resourceId: b.id,
      });
      await createBooking(room.id, holder.id, soon(2), soon(3), undefined, spec);

      await expect(
        createBooking(room.id, other.id, soon(2), soon(3), undefined, spec)
      ).rejects.toMatchObject({ status: 409 });

      expect(await events("booking_confirmed")).toHaveLength(1);
      expect(await prisma.resourceBooking.count()).toBe(1);
    });

    it("an event that cannot be recorded means no booking either", async () => {
      const room = await createAsset({ isBookable: true });

      await expect(
        createBooking(room.id, holder.id, soon(2), soon(3), undefined, () => {
          throw new Error("cannot record");
        })
      ).rejects.toThrow("cannot record");

      expect(await prisma.resourceBooking.count()).toBe(0);
      expect(await allEvents()).toBe(0);
    });

    it("cancelling records booking_cancelled once, and cancelling again records nothing", async () => {
      const room = await createAsset({ isBookable: true });
      const booking = await createBooking(room.id, holder.id, soon(2), soon(3));
      const spec = {
        action: "booking_cancelled",
        actorId: holder.id,
        resourceType: "ResourceBooking",
        resourceId: booking.id,
      };
      const actor = { userId: holder.id, role: holder.role };

      await cancelBookingAs(actor, booking.id, spec);
      await expect(cancelBookingAs(actor, booking.id, spec)).rejects.toMatchObject({ status: 409 });

      const rows = await events("booking_cancelled");
      expect(rows).toHaveLength(1);
      expect(rows[0].processedAt).not.toBeNull();
    });
  });

  describe("transfers", () => {
    async function allocated() {
      const asset = await createAsset();
      await allocateAsset(asset.id, holder.id, null, "EMPLOYEE", undefined, admin.id);
      return asset;
    }

    it("a manager's transfer records transfer_completed, an employee's records transfer_requested", async () => {
      const asset = await allocated();
      const spec = (r: { request: { id: number }; autoApproved: boolean }) => ({
        action: r.autoApproved ? "transfer_completed" : "transfer_requested",
        actorId: admin.id,
        resourceType: "TransferRequest",
        resourceId: r.request.id,
      });

      // the holder hands the asset to someone else: pending
      const pending = await createTransferRequest(
        actorOf(holder),
        { assetId: asset.id, toHolderId: other.id },
        spec
      );
      expect(pending.autoApproved).toBe(false);
      expect(await events("transfer_requested")).toHaveLength(1);
      expect(await events("transfer_completed")).toHaveLength(0);

      // an admin's own transfer is approved at once
      await prisma.transferRequest.update({ where: { id: pending.request.id }, data: { status: "CANCELLED" } });
      const done = await createTransferRequest(
        actorOf(admin),
        { assetId: asset.id, toHolderId: other.id },
        spec
      );
      expect(done.autoApproved).toBe(true);
      const completed = await events("transfer_completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].resourceId).toBe(done.request.id);
    });

    it("approving records transfer_approved once; a second approval records nothing", async () => {
      const asset = await allocated();
      const pending = await createTransferRequest(actorOf(holder), { assetId: asset.id, toHolderId: other.id });
      const spec = {
        action: "transfer_approved",
        actorId: admin.id,
        resourceType: "TransferRequest",
        resourceId: pending.request.id,
      };

      await approveTransfer(actorOf(admin), pending.request.id, spec);
      await expect(approveTransfer(actorOf(admin), pending.request.id, spec)).rejects.toMatchObject({
        status: 409,
      });

      expect(await events("transfer_approved")).toHaveLength(1);
    });
  });

  describe("maintenance", () => {
    it("approving and resolving record their events inside the transition", async () => {
      const manager = await createUser({ role: "ASSET_MANAGER" });
      const tech = await createUser();
      const asset = await createAsset();
      const request = await prisma.maintenanceRequest.create({
        data: { assetId: asset.id, requesterId: holder.id, description: "Screen is cracked", priority: "MEDIUM" },
      });
      const spec = (action: string) => ({
        action,
        actorId: manager.id,
        resourceType: "MaintenanceRequest",
        resourceId: request.id,
      });

      await approveMaintenanceRequest(request.id, manager.id, spec("maintenance_approved"));
      await assignTechnician(request.id, tech.id);
      await startMaintenanceRequest(request.id);
      await resolveMaintenanceRequest(request.id, manager.id, "Replaced", spec("maintenance_resolved"));

      for (const action of ["maintenance_approved", "maintenance_resolved"]) {
        const rows = await events(action);
        expect(rows).toHaveLength(1);
        expect(rows[0].processedAt).not.toBeNull();
      }
    });

    it("an invalid transition records no event", async () => {
      const asset = await createAsset();
      const request = await prisma.maintenanceRequest.create({
        data: { assetId: asset.id, requesterId: holder.id, description: "Screen is cracked", priority: "LOW" },
      });

      await expect(
        resolveMaintenanceRequest(request.id, admin.id, undefined, { action: "maintenance_resolved" })
      ).rejects.toMatchObject({ status: 409 });

      expect(await allEvents()).toBe(0);
    });
  });
});
