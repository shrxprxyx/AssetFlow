/**
 * Pure helpers for audits (no database access), so they are easy to test.
 */

export type CycleScope = { scopeType: string; scopeLocation: string | null };

/** What an auditor can flag. */
export const FLAGGED_STATUSES = ["MISSING", "DAMAGED"] as const;

/** An asset filter that matches nothing, for a scope that points at something that doesn't exist. */
const NOTHING = { id: -1 };

/**
 * The Prisma `where` that selects the assets a cycle covers.
 *
 * The Asset table has no department column yet, so a DEPARTMENT cycle matches
 * assets whose `location` text contains the department's name (e.g.
 * "Engineering Floor 2" belongs to Engineering). A LOCATION cycle matches the
 * location text the admin typed. A scope that points at nothing covers nothing:
 * it must never fall back to "all assets".
 */
export function scopeWhere(cycle: CycleScope, departmentName: string | null) {
  if (cycle.scopeType === "DEPARTMENT") {
    return departmentName
      ? { location: { contains: departmentName, mode: "insensitive" as const } }
      : NOTHING;
  }
  if (cycle.scopeType === "LOCATION") {
    const text = cycle.scopeLocation?.trim();
    return text ? { location: { contains: text, mode: "insensitive" as const } } : NOTHING;
  }
  return {};
}

/** A MISSING or DAMAGED finding that nobody has approved or rejected yet. */
export function discrepancyIsOpen(f: { status: string; resolutionStatus: string }) {
  return (FLAGGED_STATUSES as readonly string[]).includes(f.status) && f.resolutionStatus === "PENDING";
}
