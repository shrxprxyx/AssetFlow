"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Plus, ClipboardCheck, AlertTriangle } from "lucide-react";

type Cycle = {
  id: number;
  name: string;
  scopeType: "ALL" | "DEPARTMENT" | "LOCATION";
  scopeId: number | null;
  scopeLocation: string | null;
  startDate: string;
  endDate: string;
  status: "ACTIVE" | "CLOSED";
  closedAt: string | null;
  assetCount: number;
  checkedCount: number;
  missingCount: number;
  damagedCount: number;
  auditorCount: number;
};

type Auditor = { id: number; firstName: string; lastName: string; role: string };

type Department = { id: number; name: string };

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function AuditsPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [candidates, setCandidates] = useState<Auditor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    scopeType: "ALL" as "ALL" | "DEPARTMENT" | "LOCATION",
    scopeId: "",
    scopeLocation: "",
    auditorIds: [] as number[],
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  });

  function refetch() {
    setLoading(true);
    fetch("/api/audit-cycles?pageSize=100")
      .then((r) => r.json())
      .then((d) => {
        setCycles(d.data ?? []);
        setDepartments(d.departments ?? []);
      })
      .finally(() => setLoading(false));
  }

  useEffect(refetch, []);

  // People who can be auditors: active Admins, Asset Managers and Department Heads.
  useEffect(() => {
    if (!isAdmin) return;
    Promise.all(
      ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD"].map((role) =>
        fetch(`/api/employees?role=${role}&status=ACTIVE&pageSize=100`).then((r) => r.json())
      )
    ).then((lists) => setCandidates(lists.flatMap((l) => l.data ?? [])));
  }, [isAdmin]);

  function toggleAuditor(id: number) {
    setForm((f) => ({
      ...f,
      auditorIds: f.auditorIds.includes(id) ? f.auditorIds.filter((x) => x !== id) : [...f.auditorIds, id],
    }));
  }

  async function submitCycle() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/audit-cycles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          scopeType: form.scopeType,
          scopeId: form.scopeType === "DEPARTMENT" && form.scopeId ? Number(form.scopeId) : undefined,
          scopeLocation: form.scopeType === "LOCATION" ? form.scopeLocation : undefined,
          auditorIds: form.auditorIds,
          startDate: form.startDate,
          endDate: form.endDate,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Couldn't create the audit cycle");
        return;
      }
      setShowForm(false);
      setForm({ ...form, name: "", scopeId: "", scopeLocation: "", auditorIds: [] });
      refetch();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-2">Asset Audit Cycles</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            Run structured verification cycles and flag discrepancies
          </p>
        </div>
        {isAdmin && (
          <Button className="cursor-pointer" onClick={() => setShowForm((v) => !v)}>
            <Plus data-icon="inline-start" />
            New Audit Cycle
          </Button>
        )}
      </div>

      {showForm && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Audit name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Q3 audit: Engineering dept"
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Scope</label>
              <select
                value={form.scopeType}
                onChange={(e) => setForm({ ...form, scopeType: e.target.value as "ALL" | "DEPARTMENT" | "LOCATION" })}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              >
                <option value="ALL">All assets</option>
                <option value="DEPARTMENT">A department</option>
                <option value="LOCATION">A location</option>
              </select>
            </div>
            {form.scopeType === "DEPARTMENT" && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Department</label>
                <select
                  value={form.scopeId}
                  onChange={(e) => setForm({ ...form, scopeId: e.target.value })}
                  className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
                >
                  <option value="">Select a department…</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {form.scopeType === "LOCATION" && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Location</label>
                <input
                  type="text"
                  value={form.scopeLocation}
                  onChange={(e) => setForm({ ...form, scopeLocation: e.target.value })}
                  placeholder="e.g. Floor 2"
                  className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
                />
                <p className="text-xs text-muted-foreground">Covers every asset whose location contains this text.</p>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Start date</label>
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">End date</label>
              <input
                type="date"
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Auditors (pick one or more)</label>
            <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-background p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
              {candidates.length === 0 && <p className="text-xs text-muted-foreground p-1">Loading people…</p>}
              {candidates.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={form.auditorIds.includes(p.id)}
                    onChange={() => toggleAuditor(p.id)}
                  />
                  <span className="text-foreground">
                    {p.firstName} {p.lastName}
                  </span>
                  <span className="text-xs text-muted-foreground">{p.role.replace("_", " ").toLowerCase()}</span>
                </label>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-dashed border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button className="cursor-pointer" variant="outline" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button
              className="cursor-pointer"
              onClick={submitCycle}
              disabled={
                submitting ||
                !form.name ||
                form.auditorIds.length === 0 ||
                (form.scopeType === "DEPARTMENT" && !form.scopeId) ||
                (form.scopeType === "LOCATION" && !form.scopeLocation.trim())
              }
            >
              {submitting ? "Creating…" : "Create Cycle"}
            </Button>
          </div>
        </div>
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading audit cycles…</p>}

      {!loading && cycles.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <ClipboardCheck className="mx-auto mb-3 text-muted-foreground" size={28} />
          <p className="text-sm text-muted-foreground">
            No audit cycles yet.{isAdmin ? " Start one to verify assets against their expected locations." : ""}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cycles.map((c) => (
          <Link
            key={c.id}
            href={`/audits/${c.id}`}
            className="rounded-lg border border-border bg-card p-4 hover:border-primary/50 transition-colors"
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <h3 className="font-medium text-foreground">{c.name}</h3>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                  c.status === "ACTIVE" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                )}
              >
                {c.status === "ACTIVE" ? "Active" : "Closed"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              {c.scopeType === "ALL" ? "All assets" : c.scopeType === "LOCATION" ? `Location: ${c.scopeLocation}` : "Department scope"} ·{" "}
              {fmtDate(c.startDate)} – {fmtDate(c.endDate)} · {c.auditorCount} auditor{c.auditorCount === 1 ? "" : "s"}
            </p>
            <p className="text-sm text-foreground mb-2">
              {c.checkedCount}/{c.assetCount} checked
            </p>
            {(c.missingCount > 0 || c.damagedCount > 0) && (
              <div className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-1 text-xs text-destructive w-fit">
                <AlertTriangle size={12} />
                {c.missingCount + c.damagedCount} asset{c.missingCount + c.damagedCount === 1 ? "" : "s"} flagged
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
