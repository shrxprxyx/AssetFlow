"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowLeft, CheckCircle2, HelpCircle, AlertTriangle, XCircle, Lock } from "lucide-react";

type FindingStatus = "VERIFIED" | "MISSING" | "DAMAGED";

type ChecklistRow = {
  asset: {
    id: number;
    assetTag: string;
    name: string;
    location: string | null;
    condition: string;
    status: string;
  };
  finding: { id: number; status: FindingStatus; auditorNotes: string | null } | null;
};

type CycleDetail = {
  id: number;
  name: string;
  scopeType: "ALL" | "DEPARTMENT" | "LOCATION";
  departmentName: string | null;
  startDate: string;
  endDate: string;
  status: "ACTIVE" | "CLOSED";
  closedAt: string | null;
};

const STATUS_OPTIONS: { value: FindingStatus; label: string; icon: typeof CheckCircle2 }[] = [
  { value: "VERIFIED", label: "Verified", icon: CheckCircle2 },
  { value: "MISSING", label: "Missing", icon: XCircle },
  { value: "DAMAGED", label: "Damaged", icon: AlertTriangle },
];

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function AuditCycleDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";

  const [cycle, setCycle] = useState<CycleDetail | null>(null);
  const [checklist, setChecklist] = useState<ChecklistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingAssetId, setSavingAssetId] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeResult, setCloseResult] = useState<{ discrepancyCount: number } | null>(null);

  function refetch() {
    setLoading(true);
    fetch(`/api/audit-cycles/${params.id}`)
      .then((r) => r.json())
      .then((d) => {
        setCycle(d.cycle ?? null);
        setChecklist(d.checklist ?? []);
      })
      .finally(() => setLoading(false));
  }

  useEffect(refetch, [params.id]);

  async function recordFinding(assetId: number, status: FindingStatus) {
    setError(null);
    setSavingAssetId(assetId);
    try {
      const res = await fetch(`/api/audit-cycles/${params.id}/findings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId, status }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Couldn't record that finding");
        return;
      }
      setChecklist((prev) =>
        prev.map((row) => (row.asset.id === assetId ? { ...row, finding: data.finding } : row))
      );
    } finally {
      setSavingAssetId(null);
    }
  }

  async function closeCycle() {
    if (!confirm("Close this audit cycle? Any assets marked Missing will be flipped to Lost.")) return;
    setError(null);
    setClosing(true);
    try {
      const res = await fetch(`/api/audit-cycles/${params.id}/close`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Couldn't close the audit cycle");
        return;
      }
      setCloseResult({ discrepancyCount: data.discrepancyCount });
      refetch();
    } finally {
      setClosing(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading audit cycle…</p>;
  }

  if (!cycle) {
    return <p className="text-sm text-muted-foreground">Audit cycle not found.</p>;
  }

  const checkedCount = checklist.filter((r) => r.finding).length;
  const missingCount = checklist.filter((r) => r.finding?.status === "MISSING").length;
  const damagedCount = checklist.filter((r) => r.finding?.status === "DAMAGED").length;
  const isClosed = cycle.status === "CLOSED";

  return (
    <div className="space-y-6 sm:space-y-8">
      <Link
        href="/audits"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} /> All audit cycles
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground">{cycle.name}</h1>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                isClosed ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
              )}
            >
              {isClosed ? "Closed" : "Active"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {cycle.scopeType === "DEPARTMENT" && cycle.departmentName ? cycle.departmentName : "All assets"} ·{" "}
            {fmtDate(cycle.startDate)} – {fmtDate(cycle.endDate)} · {checkedCount}/{checklist.length} checked
          </p>
        </div>
        {isAdmin && !isClosed && (
          <Button className="cursor-pointer" variant="destructive" onClick={closeCycle} disabled={closing}>
            <Lock data-icon="inline-start" />
            {closing ? "Closing…" : "Close Audit Cycle"}
          </Button>
        )}
      </div>

      {closeResult && (
        <div className="rounded-lg border border-dashed border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive flex items-center gap-2">
          <AlertTriangle size={16} />
          {closeResult.discrepancyCount} asset{closeResult.discrepancyCount === 1 ? "" : "s"} flagged
        </div>
      )}

      {!closeResult && isClosed && (missingCount > 0 || damagedCount > 0) && (
        <div className="rounded-lg border border-dashed border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive flex items-center gap-2">
          <AlertTriangle size={16} />
          {missingCount + damagedCount} asset{missingCount + damagedCount === 1 ? "" : "s"} flagged
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-dashed border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {isClosed && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <Lock size={14} /> This cycle is closed. Findings are locked.
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 text-left font-medium">Asset</th>
              <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">Expected Location</th>
              <th className="px-4 py-2.5 text-left font-medium">Verification</th>
            </tr>
          </thead>
          <tbody>
            {checklist.map((row) => (
              <tr key={row.asset.id} className="border-t border-border">
                <td className="px-4 py-3">
                  <div className="text-foreground">{row.asset.name}</div>
                  <div className="text-xs text-muted-foreground">{row.asset.assetTag}</div>
                </td>
                <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                  {row.asset.location ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {STATUS_OPTIONS.map(({ value, label, icon: Icon }) => {
                      const active = row.finding?.status === value;
                      return (
                        <button
                          key={value}
                          disabled={isClosed || savingAssetId === row.asset.id}
                          onClick={() => recordFinding(row.asset.id, value)}
                          className={cn(
                            "inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                            active && value === "VERIFIED" && "border-primary/40 bg-primary/10 text-primary",
                            active && value === "MISSING" && "border-destructive/40 bg-destructive/10 text-destructive",
                            active && value === "DAMAGED" && "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
                            !active && "border-border text-muted-foreground hover:bg-muted"
                          )}
                        >
                          <Icon size={12} />
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {checklist.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            <HelpCircle className="mx-auto mb-2" size={20} />
            No assets fall in this audit's scope.
          </div>
        )}
      </div>
    </div>
  );
}
