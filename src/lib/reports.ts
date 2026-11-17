import { prisma } from "./prisma";
import { buildHeatmap } from "./heatmap";

const MONTHS_BACK = 6;

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

// ── Utilization by department ───────────────────────────────────────
// "Utilization" here = how many of a department's currently-held assets
// are actively allocated out, vs. sitting available. We treat an asset as
// "belonging" to a department if it has ever been allocated to someone
// in that department (its most recent allocation determines the dept).
export async function getUtilizationByDepartment() {
  const departments = await prisma.department.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
  });

  const allocations = await prisma.allocation.findMany({
    include: { holder: { select: { departmentId: true } }, asset: { select: { id: true, status: true } } },
    orderBy: { allocatedDate: "desc" },
  });

  // Latest allocation per asset decides which department "owns" it for reporting.
  const latestByAsset = new Map<number, (typeof allocations)[number]>();
  for (const a of allocations) {
    if (!latestByAsset.has(a.assetId)) latestByAsset.set(a.assetId, a);
  }

  const result = departments.map((dept) => {
    const deptAssets = [...latestByAsset.values()].filter((a) => a.holder?.departmentId === dept.id);
    const total = deptAssets.length;
    const allocated = deptAssets.filter((a) => a.status === "ACTIVE").length;
    return {
      department: dept.name,
      total,
      allocated,
      utilizationPct: total > 0 ? Math.round((allocated / total) * 100) : 0,
    };
  });

  return result.filter((r) => r.total > 0);
}

// ── Maintenance frequency over time ─────────────────────────────────
export async function getMaintenanceFrequency() {
  const since = new Date();
  since.setMonth(since.getMonth() - (MONTHS_BACK - 1));
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const requests = await prisma.maintenanceRequest.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true },
  });

  const buckets = new Map<string, { label: string; count: number }>();
  for (let i = 0; i < MONTHS_BACK; i++) {
    const d = new Date(since);
    d.setMonth(d.getMonth() + i);
    buckets.set(monthKey(d), { label: monthLabel(d), count: 0 });
  }
  for (const r of requests) {
    const key = monthKey(r.createdAt);
    const bucket = buckets.get(key);
    if (bucket) bucket.count += 1;
  }

  return [...buckets.values()];
}

// ── Most-used assets (bookings + allocations) ───────────────────────
export async function getMostUsedAssets(limit = 10) {
  const assets = await prisma.asset.findMany({
    select: {
      id: true,
      assetTag: true,
      name: true,
      _count: { select: { bookings: true, allocations: true } },
    },
  });

  return assets
    .map((a) => ({
      assetId: a.id,
      assetTag: a.assetTag,
      name: a.name,
      bookingCount: a._count.bookings,
      allocationCount: a._count.allocations,
      totalUsage: a._count.bookings + a._count.allocations,
    }))
    .filter((a) => a.totalUsage > 0)
    .sort((a, b) => b.totalUsage - a.totalUsage)
    .slice(0, limit);
}

// ── Idle assets (available, never allocated) ────────────────────────
export async function getIdleAssets(limit = 10) {
  const assets = await prisma.asset.findMany({
    where: { status: "AVAILABLE", allocations: { none: {} } },
    select: { id: true, assetTag: true, name: true, location: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  return assets.map((a) => ({
    assetId: a.id,
    assetTag: a.assetTag,
    name: a.name,
    location: a.location,
    daysIdle: Math.floor((Date.now() - a.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
  }));
}

// ── Assets needing attention (poor condition or long in service) ────
const RETIREMENT_THRESHOLD_YEARS = 3;

export async function getDueForMaintenance(limit = 10) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - RETIREMENT_THRESHOLD_YEARS);

  const assets = await prisma.asset.findMany({
    where: {
      status: { not: "UNDER_MAINTENANCE" },
      OR: [{ condition: "POOR" }, { acquisitionDate: { lt: cutoff } }],
    },
    select: {
      id: true,
      assetTag: true,
      name: true,
      condition: true,
      acquisitionDate: true,
      status: true,
    },
    take: limit,
  });

  return assets.map((a) => ({
    assetId: a.id,
    assetTag: a.assetTag,
    name: a.name,
    condition: a.condition,
    status: a.status,
    reason:
      a.condition === "POOR" && a.acquisitionDate && a.acquisitionDate < cutoff
        ? "Poor condition & nearing retirement"
        : a.condition === "POOR"
        ? "Poor condition"
        : `${RETIREMENT_THRESHOLD_YEARS}+ years in service`,
  }));
}

export async function getReportsSummary() {
  const [utilizationByDepartment, maintenanceFrequency, mostUsedAssets, idleAssets, dueForMaintenance] =
    await Promise.all([
      getUtilizationByDepartment(),
      getMaintenanceFrequency(),
      getMostUsedAssets(),
      getIdleAssets(),
      getDueForMaintenance(),
    ]);

  const totalAssets = await prisma.asset.count();
  const avgUtilization =
    utilizationByDepartment.length > 0
      ? Math.round(
          utilizationByDepartment.reduce((sum, d) => sum + d.utilizationPct, 0) / utilizationByDepartment.length
        )
      : 0;
  const maintenanceThisMonth = maintenanceFrequency[maintenanceFrequency.length - 1]?.count ?? 0;

  return {
    utilizationByDepartment,
    maintenanceFrequency,
    mostUsedAssets,
    idleAssets,
    dueForMaintenance,
    summary: {
      totalAssets,
      avgUtilization,
      maintenanceThisMonth,
      idleCount: idleAssets.length,
      attentionCount: dueForMaintenance.length,
    },
  };
}

// ── Booking heatmap (weekday x hour) ────────────────────────────────
export async function getBookingHeatmap(opts: { days: number; timeZone: string; now?: Date }) {
  const now = opts.now ?? new Date();
  // buildHeatmap with no bookings gives us the exact window to query.
  const shape = buildHeatmap([], { now, days: opts.days, timeZone: opts.timeZone, resourceCount: 0 });

  const [resourceCount, bookings] = await Promise.all([
    prisma.asset.count({ where: { isBookable: true } }),
    prisma.resourceBooking.findMany({
      where: {
        status: { not: "CANCELLED" },
        startTime: { lt: shape.to },
        endTime: { gt: shape.from },
      },
      select: { startTime: true, endTime: true },
    }),
  ]);

  return buildHeatmap(bookings, { now, days: opts.days, timeZone: opts.timeZone, resourceCount });
}
