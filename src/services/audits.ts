import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { scopeWhere, type CycleScope } from "@/utils/auditScope";

export { scopeWhere, FLAGGED_STATUSES, discrepancyIsOpen } from "@/utils/auditScope";

export type ScopedAsset = {
  id: number;
  assetTag: string;
  name: string;
  location: string | null;
  condition: string;
  status: string;
};

const ASSET_SELECT = {
  id: true,
  assetTag: true,
  name: true,
  location: true,
  condition: true,
  status: true,
} as const;

/** Roles that may be assigned as auditors. Employees can't audit. */
export const AUDITOR_ROLES = ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD"] as const;

type Cycle = CycleScope & { scopeId: number | null };

/** The `where` for the assets a cycle covers (see scopeWhere for the rules). */
export async function cycleAssetFilter(cycle: Cycle): Promise<Prisma.AssetWhereInput> {
  let departmentName: string | null = null;
  if (cycle.scopeType === "DEPARTMENT" && cycle.scopeId) {
    const department = await prisma.department.findUnique({
      where: { id: cycle.scopeId },
      select: { name: true },
    });
    departmentName = department?.name ?? null;
  }
  return scopeWhere(cycle, departmentName);
}

/** The assets in scope for an audit cycle: the auditor's checklist. */
export async function getAssetsInScope(cycle: Cycle): Promise<ScopedAsset[]> {
  return prisma.asset.findMany({
    where: await cycleAssetFilter(cycle),
    orderBy: { assetTag: "asc" },
    select: ASSET_SELECT,
  });
}

/** Same rule, but a count: for the cycle list, which would otherwise load every asset. */
export async function countAssetsInScope(cycle: Cycle): Promise<number> {
  return prisma.asset.count({ where: await cycleAssetFilter(cycle) });
}

/** Is this asset one the cycle is allowed to record a finding for? */
export async function isAssetInScope(cycle: Cycle, assetId: number): Promise<boolean> {
  const where = await cycleAssetFilter(cycle);
  return (await prisma.asset.count({ where: { AND: [{ id: assetId }, where] } })) > 0;
}

export async function isAssignedAuditor(cycleId: number, userId: number): Promise<boolean> {
  return (await prisma.auditAssignment.count({ where: { cycleId, auditorId: userId } })) > 0;
}

/**
 * Checks that every id is an active user who may audit. Returns the unique ids,
 * or an error message for the first problem.
 */
export async function validateAuditors(
  auditorIds: number[]
): Promise<{ ok: true; ids: number[] } | { ok: false; message: string }> {
  const ids = [...new Set(auditorIds)];
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, role: true, status: true },
  });
  if (users.length !== ids.length) return { ok: false, message: "One of the selected auditors was not found" };
  if (users.some((u) => u.status !== "ACTIVE")) return { ok: false, message: "Auditors must be active users" };
  if (users.some((u) => !(AUDITOR_ROLES as readonly string[]).includes(u.role))) {
    return { ok: false, message: "Auditors must be an Admin, Asset Manager or Department Head" };
  }
  return { ok: true, ids };
}
