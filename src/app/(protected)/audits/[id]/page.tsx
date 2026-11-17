"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/utils";
import { ArrowLeft, CheckCircle2, HelpCircle, AlertTriangle, XCircle, Lock, UserPlus, X } from "lucide-react";

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
  finding: { id: number; status: FindingStatus; auditorNotes: string | null; resolutionStatus: string } | null;
};

type CycleDetail = {
  id: number;
  name: string;
  scopeType: "ALL" | "DEPARTMENT" | "LOCATION";
  scopeLocation: string | null;
  departmentName: string | null;
  startDate: string;
  endDate: string;
  status: "ACTIVE" | "CLOSED";
  closedAt: string | null;
};

type Auditor = { id: number; name: string; role: string };
type Permissions = { canRecord: boolean; canResolve: boolean; canManageAuditors: boolean };
type Discrepancy = {
  findingId: number;
  status: "MISSING" | "DAMAGED";
  auditorNotes: string | null;
  auditor: string;
  asset: { id: number; assetTag: string; name: string; location: string | null };
  resolutionStatus: "PENDING" | "APPROVED" | "REJECTED";
};
type Candidate = { id: number; firstName: string; lastName: string };

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
  const [auditors, setAuditors] = useState<Auditor[]>([]);
  const [permissions, setPermissions] = useState<Permissions>({ canRecord: false, canResolve: false, canManageAuditors: false });
  const [report, setReport] = useState<Discrepancy[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [addingId, setAddingId] = useState("");
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  function refetch() {
    setLoading(true);
    Promise.all([
      fetch(`/api/audit-cycles/${params.id}`).then((r) => r.json()),
      fetch(`/api/audit-cycles/${params.id}/discrepancies`).then((r) => r.json()),
    ])
      .then(([d, report]) => {
        setCycle(d.cycle ?? null);
        setChecklist(d.checklist ?? []);
        setAuditors(d.auditors ?? []);
        if (d.permissions) setPermissions(d.permissions);
        setReport(report.data ?? []);
      })
      .finally(() => setLoading(false));
  }

  useEffect(refetch, [params.id]);

  // People an Admin can still add: active Admins, Asset Managers and Department Heads.
  useEffect(() => {
    if (!permissions.canManageAuditors) return;
    Promise.all(
      ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD"].map((role) =>
        fetch(`/api/employees?role=${role}&status=ACTIVE&pageSize=100`).then((r) => r.json())
      )
    ).then((lists) => setCandidates(lists.flatMap((l) => l.data ?? [])));
  }, [permissions.canManageAuditors]);

  async function addAuditor() {
    if (!addingId) return;
    setError(null);
    const res = await fetch(`/api/audit-cycles/${params.id}/auditors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auditorIds: [Number(addingId)] }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.message ?? "Couldn't add the auditor");
    setAddingId("");
    refetch();
  }

  async function removeAuditor(auditorId: number) {
    setError(null);
    const res = await fetch(`/api/audit-cycles/${params.id}/auditors?auditorId=${auditorId}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) return setError(data.message ?? "Couldn't remove the auditor");
    refetch();
  }

  async function decide(findingId: number, decision: "APPROVED" | "REJECTED") {
    setError(null);
    setResolvingId(findingId);
    try {
      const res = await fetch(`/api/audit-cycles/${params.id}/findings/${findingId}/resolution`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json();
      if (!res.ok) return setError(data.message ?? "Couldn't save that decision");
      setReport((prev) => prev.map((d) => (d.findingId === findingId ? { ...d, resolutionStatus: decision } : d)));
    } finally {
      setResolvingId(null);
    }
  }

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
      // The discrepancy report follows the findings.
      fetch(`/api/audit-cycles/${params.id}/discrepancies`)
        .then((r) => r.json())
        .then((r) => setReport(r.data ?? []));
    } finally {
      setSavingAssetId(null);
    }
  }

  async function closeCycle() {
    if (!confirm("Close this audit cycle? Approved Missing assets will be marked Lost. This locks every finding.")) return;
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
            {cycle.scopeType === "DEPARTMENT" && cycle.departmentName
              ? cycle.departmentName
              : cycle.scopeType === "LOCATION"
                ? `Location: ${cycle.scopeLocation}`
                : "All assets"}{" "}
            ·{" "}
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

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Auditors</h2>
        <div className="flex flex-wrap gap-2">
          {auditors.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-foreground">
              {a.name}
              {permissions.canManageAuditors && auditors.length > 1 && (
                <button
                  className="cursor-pointer text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => removeAuditor(a.id)}
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
        {permissions.canManageAuditors && (
          <div className="flex gap-2">
            <select
              value={addingId}
              onChange={(e) => setAddingId(e.target.value)}
              className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="">Add an auditor…</option>
              {candidates
                .filter((c) => !auditors.some((a) => a.id === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.firstName} {c.lastName}
                  </option>
                ))}
            </select>
            <Button className="cursor-pointer" variant="outline" onClick={addAuditor} disabled={!addingId}>
              <UserPlus data-icon="inline-start" /> Add
            </Button>
          </div>
        )}
        {!permissions.canRecord && !isClosed && (
          <p className="text-xs text-muted-foreground">Only the assigned auditors can mark assets.</p>
        )}
      </section>

      {report.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">
            Discrepancy report ({report.length})
          </h2>
          <div className="divide-y divide-border">
            {report.map((d) => (
              <div key={d.findingId} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">
                    {d.asset.name} <span className="text-xs text-muted-foreground">{d.asset.assetTag}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {d.status === "MISSING" ? "Missing" : "Damaged"} · flagged by {d.auditor}
                    {d.auditorNotes ? ` · ${d.auditorNotes}` : ""}
                  </p>
                </div>
                {d.resolutionStatus === "PENDING" && permissions.canResolve ? (
                  <div className="flex gap-2">
                    <Button
                      className="cursor-pointer"
                      size="sm"
                      disabled={resolvingId === d.findingId}
                      onClick={() => decide(d.findingId, "APPROVED")}
                    >
                      Approve
                    </Button>
                    <Button
                      className="cursor-pointer"
                      size="sm"
                      variant="outline"
                      disabled={resolvingId === d.findingId}
                      onClick={() => decide(d.findingId, "REJECTED")}
                    >
                      Reject
                    </Button>
                  </div>
                ) : (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-medium",
                      d.resolutionStatus === "APPROVED" && "bg-primary/10 text-primary",
                      d.resolutionStatus === "REJECTED" && "bg-muted text-muted-foreground",
                      d.resolutionStatus === "PENDING" && "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    )}
                  >
                    {d.resolutionStatus === "PENDING" ? "Awaiting decision" : d.resolutionStatus === "APPROVED" ? "Approved" : "Rejected"}
                  </span>
                )}
              </div>
            ))}
          </div>
          {permissions.canResolve && (
            <p className="text-xs text-muted-foreground">
              Approve to confirm a finding (a confirmed Missing asset becomes Lost when the cycle closes). Reject to dismiss it.
            </p>
          )}
        </section>
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
                          disabled={!permissions.canRecord || savingAssetId === row.asset.id}
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
