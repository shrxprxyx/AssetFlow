import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding...");

  const passwordHash = await bcrypt.hash("password123", 10);

  // ── Departments ──────────────────────────────────────
  const engineering = await prisma.department.create({
    data: { name: "Engineering", description: "Engineering department", status: "ACTIVE" },
  });
  const facilities = await prisma.department.create({
    data: { name: "Facilities", description: "Facilities & operations", status: "ACTIVE" },
  });

  // ── Categories ───────────────────────────────────────
  const laptopCategory = await prisma.assetCategory.create({
    data: { name: "Laptop", description: "Portable computers" },
  });
  const roomCategory = await prisma.assetCategory.create({
    data: { name: "Meeting Room", description: "Bookable shared spaces" },
  });

  // ── Users (4 roles) ──────────────────────────────────
  const admin = await prisma.user.create({
    data: {
      email: "admin@assetflow.com",
      passwordHash,
      emailVerifiedAt: new Date(),
      firstName: "Alex",
      lastName: "Admin",
      role: "ADMIN",
      departmentId: engineering.id,
    },
  });

  const assetManager = await prisma.user.create({
    data: {
      email: "manager@assetflow.com",
      passwordHash,
      emailVerifiedAt: new Date(),
      firstName: "Morgan",
      lastName: "Manager",
      role: "ASSET_MANAGER",
      departmentId: engineering.id,
    },
  });

  const deptHead = await prisma.user.create({
    data: {
      email: "head@assetflow.com",
      passwordHash,
      emailVerifiedAt: new Date(),
      firstName: "Dana",
      lastName: "Head",
      role: "DEPARTMENT_HEAD",
      departmentId: facilities.id,
    },
  });

  const priya = await prisma.user.create({
    data: {
      email: "priya.shah@assetflow.com",
      passwordHash,
      emailVerifiedAt: new Date(),
      firstName: "Priya",
      lastName: "Shah",
      role: "EMPLOYEE",
      departmentId: engineering.id,
    },
  });

  // link department heads
  await prisma.department.update({ where: { id: facilities.id }, data: { headId: deptHead.id } });
  await prisma.department.update({ where: { id: engineering.id }, data: { headId: admin.id } });

  // ── Assets (~8) ──────────────────────────────────────
  const dellLaptop = await prisma.asset.create({
    data: {
      assetTag: "AF-0114",
      name: "Dell Laptop",
      categoryId: laptopCategory.id,
      serialNumber: "SN-DELL-0114",
      condition: "GOOD",
      location: "Engineering Floor 2",
      status: "ALLOCATED", // pre-allocated
    },
  });

  const macbook = await prisma.asset.create({
    data: {
      assetTag: "AF-0012",
      name: "MacBook Pro",
      categoryId: laptopCategory.id,
      serialNumber: "SN-MBP-0012",
      condition: "GOOD",
      location: "Engineering Floor 2",
      status: "AVAILABLE",
    },
  });

  await prisma.asset.create({
    data: {
      assetTag: "AF-0062",
      name: "Projector",
      categoryId: roomCategory.id,
      serialNumber: "SN-PROJ-0062",
      condition: "FAIR",
      location: "Facilities Storage",
      status: "AVAILABLE",
    },
  });

  await prisma.asset.create({
    data: {
      assetTag: "AF-0201",
      name: "Office Chair",
      categoryId: roomCategory.id,
      serialNumber: "SN-CHAIR-0201",
      condition: "GOOD",
      location: "Facilities Storage",
      status: "AVAILABLE",
    },
  });

  const conferenceRoomB2 = await prisma.asset.create({
    data: {
      assetTag: "AF-0300",
      name: "Conference Room B2",
      categoryId: roomCategory.id,
      condition: "GOOD",
      location: "Building B, Floor 2",
      isBookable: true,
      status: "AVAILABLE",
    },
  });

  await prisma.asset.create({
    data: {
      assetTag: "AF-0301",
      name: "Conference Room A1",
      categoryId: roomCategory.id,
      condition: "GOOD",
      location: "Building A, Floor 1",
      isBookable: true,
      status: "AVAILABLE",
    },
  });

  await prisma.asset.create({
    data: {
      assetTag: "AF-0055",
      name: "External Monitor",
      categoryId: laptopCategory.id,
      serialNumber: "SN-MON-0055",
      condition: "GOOD",
      location: "Engineering Floor 2",
      status: "AVAILABLE",
    },
  });

  await prisma.asset.create({
    data: {
      assetTag: "AF-0088",
      name: "Standing Desk",
      categoryId: roomCategory.id,
      condition: "POOR",
      location: "Facilities Storage",
      status: "UNDER_MAINTENANCE",
    },
  });

  // ── Pre-allocate AF-0114 to Priya Shah ───────────────
  await prisma.allocation.create({
    data: {
      assetId: dellLaptop.id,
      holderId: priya.id,
      holderType: "EMPLOYEE",
      status: "ACTIVE",
      expectedReturnDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days out
    },
  });

  await prisma.assetHistory.create({
    data: {
      assetId: dellLaptop.id,
      toStatus: "ALLOCATED",
      actorId: assetManager.id,
      reason: "Initial allocation (seed)",
    },
  });

  // ── Existing 9:00–10:00 booking on Conference Room B2 ─
  const today = new Date();
  today.setHours(9, 0, 0, 0);
  const bookingStart = new Date(today);
  const bookingEnd = new Date(today);
  bookingEnd.setHours(10, 0, 0, 0);

  await prisma.resourceBooking.create({
    data: {
      resourceId: conferenceRoomB2.id,
      bookerId: deptHead.id,
      startTime: bookingStart,
      endTime: bookingEnd,
      purpose: "Weekly sync",
      status: "UPCOMING",
    },
  });

  // The seed chose its own asset tags; move the tag sequence past them.
  await prisma.$queryRawUnsafe(`
    SELECT setval('asset_tag_seq', GREATEST(
      COALESCE((SELECT max(substring("assetTag" from 4)::bigint) FROM "Asset" WHERE "assetTag" ~ '^AF-[0-9]+$'), 0),
      (SELECT last_value FROM asset_tag_seq)
    ), true)
  `);

  console.log("Seed complete.");
  console.log({
    admin: admin.email,
    assetManager: assetManager.email,
    deptHead: deptHead.email,
    priya: priya.email,
    password: "password123 (for all seeded users)",
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });