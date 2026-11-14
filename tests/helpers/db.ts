import { prisma } from "@/lib/prisma";
import type { AssetStatus, Role, UserStatus } from "@prisma/client";

/** Empty every table (keeps the schema, indexes and constraints). */
export async function resetDb() {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

let seq = 0;

export function createDepartment(name = `Dept ${++seq}`) {
  return prisma.department.create({ data: { name } });
}

export function createUser(
  o: { role?: Role; departmentId?: number | null; status?: UserStatus } = {}
) {
  const n = ++seq;
  return prisma.user.create({
    data: {
      email: `user${n}@test.local`,
      passwordHash: "not-a-real-hash",
      firstName: "User",
      lastName: `N${n}`,
      role: o.role ?? "EMPLOYEE",
      departmentId: o.departmentId ?? null,
      status: o.status ?? "ACTIVE",
    },
  });
}

export function createCategory(name = `Category ${++seq}`) {
  return prisma.assetCategory.create({ data: { name } });
}

export async function createAsset(
  o: { categoryId?: number; isBookable?: boolean; status?: AssetStatus; name?: string; location?: string } = {}
) {
  const n = ++seq;
  const categoryId = o.categoryId ?? (await createCategory()).id;
  return prisma.asset.create({
    data: {
      assetTag: `T-${String(n).padStart(4, "0")}`,
      name: o.name ?? `Asset ${n}`,
      categoryId,
      isBookable: o.isBookable ?? false,
      status: o.status ?? "AVAILABLE",
      location: o.location,
    },
  });
}