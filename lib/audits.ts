import { prisma } from "./prisma";

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

/**
 * Returns the assets in scope for an audit cycle.
 *
 * Demo simplification (per the 6-hour build plan, Section 4 — "simplify to
 * all assets in a department"): the Asset model has no direct departmentId,
 * so a DEPARTMENT-scoped cycle matches assets whose `location` field
 * contains the department's name (e.g. "Engineering Floor 2" -> Engineering).
 * This also lines up with the wireframe's "Expected Location" column on
 * Screen 8. LOCATION scope isn't wired up for this build — treat it as ALL.
 */
export async function getAssetsInScope(
  scopeType: string,
  scopeId: number | null
): Promise<ScopedAsset[]> {
  if (scopeType === "DEPARTMENT" && scopeId) {
    const department = await prisma.department.findUnique({
      where: { id: scopeId },
      select: { name: true },
    });
    if (!department) return [];

    return prisma.asset.findMany({
      where: { location: { contains: department.name, mode: "insensitive" } },
      orderBy: { assetTag: "asc" },
      select: ASSET_SELECT,
    });
  }

  return prisma.asset.findMany({
    orderBy: { assetTag: "asc" },
    select: ASSET_SELECT,
  });
}