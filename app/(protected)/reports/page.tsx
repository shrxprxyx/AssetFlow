"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Package,
  TrendingUp,
  Wrench,
  AlertTriangle,
  Download,
  Archive,
  Flame,
} from "lucide-react";

type ReportsData = {
  utilizationByDepartment: { department: string; total: number; allocated: number; utilizationPct: number }[];
  maintenanceFrequency: { label: string; count: number }[];
  mostUsedAssets: { assetId: number; assetTag: string; name: string; bookingCount: number; allocationCount: number; totalUsage: number }[];
  idleAssets: { assetId: number; assetTag: string; name: string; location: string | null; daysIdle: number }[];
  dueForMaintenance: { assetId: number; assetTag: string; name: string; condition: string; status: string; reason: string }[];
  summary: {
    totalAssets: number;
    avgUtilization: number;
    maintenanceThisMonth: number;
    idleCount: number;
    attentionCount: number;
  };
};

function KpiCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-bold text-foreground">{value}</p>
            {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
          </div>
          <div className="rounded-lg bg-primary/10 p-2 text-primary">{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-muted", className)} />;
}

function toCsvValue(value: string | number) {
  const s = String(value);
  return s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportReportCsv(data: ReportsData) {
  const lines: string[] = [];

  lines.push("AssetFlow Report Export", new Date().toLocaleString());
  lines.push("");

  lines.push("Utilization by Department");
  lines.push("Department,Total Assets,Allocated,Utilization %");
  data.utilizationByDepartment.forEach((r) =>
    lines.push([r.department, r.total, r.allocated, r.utilizationPct].map(toCsvValue).join(","))
  );
  lines.push("");

  lines.push("Maintenance Frequency (last 6 months)");
  lines.push("Month,Requests");
  data.maintenanceFrequency.forEach((r) => lines.push([r.label, r.count].map(toCsvValue).join(",")));
  lines.push("");

  lines.push("Most Used Assets");
  lines.push("Tag,Name,Bookings,Allocations,Total Usage");
  data.mostUsedAssets.forEach((r) =>
    lines.push([r.assetTag, r.name, r.bookingCount, r.allocationCount, r.totalUsage].map(toCsvValue).join(","))
  );
  lines.push("");

  lines.push("Idle Assets");
  lines.push("Tag,Name,Location,Days Idle");
  data.idleAssets.forEach((r) =>
    lines.push([r.assetTag, r.name, r.location ?? "—", r.daysIdle].map(toCsvValue).join(","))
  );
  lines.push("");

  lines.push("Assets Needing Attention");
  lines.push("Tag,Name,Condition,Reason");
  data.dueForMaintenance.forEach((r) =>
    lines.push([r.assetTag, r.name, r.condition, r.reason].map(toCsvValue).join(","))
  );

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `assetflow-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const [data, setData] = useState<ReportsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/reports")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError("Couldn't load reports"));
  }, []);

  return (
    <div className="space-y-6 sm:space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-2">Reports & Analytics</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            Utilization trends, maintenance frequency, and asset lifecycle signals
          </p>
        </div>
        <Button
          variant="outline"
          disabled={!data}
          onClick={() => data && exportReportCsv(data)}
          className="cursor-pointer"
        >
          <Download data-icon="inline-start" />
          Export Report
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-dashed border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-24" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard
              icon={<Package size={18} />}
              label="Total Assets"
              value={data.summary.totalAssets}
            />
            <KpiCard
              icon={<TrendingUp size={18} />}
              label="Avg. Utilization"
              value={`${data.summary.avgUtilization}%`}
              hint="across departments"
            />
            <KpiCard
              icon={<Wrench size={18} />}
              label="Maintenance This Month"
              value={data.summary.maintenanceThisMonth}
              hint="requests raised"
            />
            <KpiCard
              icon={<AlertTriangle size={18} />}
              label="Needs Attention"
              value={data.summary.attentionCount}
              hint="poor condition or aging"
            />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Utilization by Department</CardTitle>
                <CardDescription>Currently allocated vs. total assets held per department</CardDescription>
              </CardHeader>
              <CardContent>
                {data.utilizationByDepartment.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    No department allocation data yet.
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={data.utilizationByDepartment} margin={{ left: -20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="department" stroke="var(--muted-foreground)" fontSize={12} />
                      <YAxis stroke="var(--muted-foreground)" fontSize={12} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{
                          background: "var(--popover)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                          color: "var(--popover-foreground)",
                        }}
                      />
                      <Bar dataKey="total" name="Total assets" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="allocated" name="Allocated" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Maintenance Frequency</CardTitle>
                <CardDescription>Requests raised per month, last 6 months</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={data.maintenanceFrequency} margin={{ left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="label" stroke="var(--muted-foreground)" fontSize={12} />
                    <YAxis stroke="var(--muted-foreground)" fontSize={12} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        fontSize: 12,
                        color: "var(--popover-foreground)",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="count"
                      name="Requests"
                      stroke="var(--primary)"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          {/* Tables */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Flame size={16} className="text-primary" /> Most Used Assets
                </CardTitle>
                <CardDescription>Bookings + allocations, all time</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {data.mostUsedAssets.length === 0 ? (
                  <p className="px-6 pb-6 text-sm text-muted-foreground">No usage recorded yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-t border-border text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-6 py-2 text-left font-medium">Asset</th>
                        <th className="px-6 py-2 text-right font-medium">Usage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.mostUsedAssets.map((a) => (
                        <tr key={a.assetId} className="border-t border-border">
                          <td className="px-6 py-2">
                            <div className="text-foreground">{a.name}</div>
                            <div className="text-xs text-muted-foreground">{a.assetTag}</div>
                          </td>
                          <td className="px-6 py-2 text-right font-medium text-foreground">{a.totalUsage}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Archive size={16} className="text-muted-foreground" /> Idle Assets
                </CardTitle>
                <CardDescription>Available, never allocated</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {data.idleAssets.length === 0 ? (
                  <p className="px-6 pb-6 text-sm text-muted-foreground">Nothing sitting idle right now.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-t border-border text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-6 py-2 text-left font-medium">Asset</th>
                        <th className="px-6 py-2 text-right font-medium">Idle</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.idleAssets.map((a) => (
                        <tr key={a.assetId} className="border-t border-border">
                          <td className="px-6 py-2">
                            <div className="text-foreground">{a.name}</div>
                            <div className="text-xs text-muted-foreground">{a.location ?? a.assetTag}</div>
                          </td>
                          <td className="px-6 py-2 text-right text-muted-foreground">{a.daysIdle}d</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle size={16} className="text-destructive" /> Needs Attention
                </CardTitle>
                <CardDescription>Poor condition or 3+ years in service</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {data.dueForMaintenance.length === 0 ? (
                  <p className="px-6 pb-6 text-sm text-muted-foreground">Nothing flagged right now.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-t border-border text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-6 py-2 text-left font-medium">Asset</th>
                        <th className="px-6 py-2 text-left font-medium">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.dueForMaintenance.map((a) => (
                        <tr key={a.assetId} className="border-t border-border">
                          <td className="px-6 py-2">
                            <div className="text-foreground">{a.name}</div>
                            <div className="text-xs text-muted-foreground">{a.assetTag}</div>
                          </td>
                          <td className="px-6 py-2">
                            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                              {a.reason}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
