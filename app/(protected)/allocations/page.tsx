"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState, EmptyState } from "@/components/ui";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────

type Asset = {
  id: number;
  assetTag: string;
  name: string;
  status: string;
  currentHolder?: { id: number; firstName: string; lastName: string } | null;
};

type Employee = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  departmentName?: string;
};

type Allocation = {
  id: number;
  assetId: number;
  holderId: number | null;
  allocatedDate: string;
  expectedReturnDate: string | null;
  status: string;
  holder?: { id: number; firstName: string; lastName: string; email: string } | null;
  asset?: { id: number; assetTag: string; name: string; status: string } | null;
};

type HistoryEntry = {
  id: number;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  createdAt: string;
  actor: { id: number; firstName: string; lastName: string } | null;
};

type ConflictInfo = { id: number; name: string; allocatedDate: string };

const inputClass =
  "h-10 px-3 rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-3 focus:ring-ring/50";

function Pill({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-block px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap", className)}>
      {children}
    </span>
  );
}

// ── Page ───────────────────────────────────────────────

export default function AllocationsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [activeAllocations, setActiveAllocations] = useState<Allocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Allocate form
  const [assetId, setAssetId] = useState("");
  const [holderId, setHolderId] = useState("");
  const [expectedReturnDate, setExpectedReturnDate] = useState("");
  const [allocating, setAllocating] = useState(false);

  // Conflict + transfer request state
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [transferToId, setTransferToId] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [transferring, setTransferring] = useState(false);

  // Return flow (per-row)
  const [returningId, setReturningId] = useState<number | null>(null);
  const [returnCondition, setReturnCondition] = useState<Record<number, string>>({});
  const [returnNotes, setReturnNotes] = useState<Record<number, string>>({});
  const [submittingReturn, setSubmittingReturn] = useState<number | null>(null);

  // History for the selected asset
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  async function refetch() {
    setLoading(true);
    setError("");
    try {
      const [assetsRes, employeesRes, allocationsRes] = await Promise.all([
        fetch("/api/assets"),
        fetch("/api/employees"),
        fetch("/api/allocations?status=ACTIVE"),
      ]);
      const assetsData = await assetsRes.json();
      const employeesData = await employeesRes.json();
      const allocationsData = await allocationsRes.json();
      if (!assetsRes.ok) throw new Error(assetsData.message || assetsData.error || "Failed to load assets");
      setAssets(assetsData);
      setEmployees(employeesData);
      setActiveAllocations(allocationsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refetch();
  }, []);

  useEffect(() => {
    if (!assetId) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    fetch(`/api/assets/${assetId}/history`)
      .then((r) => r.json())
      .then((d) => setHistory(d.data ?? []))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [assetId]);

  const selectedAsset = useMemo(() => assets.find((a) => String(a.id) === assetId) ?? null, [assets, assetId]);

  async function allocate() {
    setError("");
    setNotice("");
    setConflict(null);
    if (!assetId) {
      setError("Select an asset");
      return;
    }
    if (!holderId) {
      setError("Select an employee to allocate to");
      return;
    }
    setAllocating(true);
    try {
      const res = await fetch("/api/allocations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: Number(assetId),
          holderId: Number(holderId),
          holderType: "EMPLOYEE",
          expectedReturnDate: expectedReturnDate || undefined,
        }),
      });
      const data = await res.json();

      if (res.status === 409) {
        // Conflict — asset already has an active allocation. currently_held_by
        // is snake_case on the wire (see app/api/allocations/route.ts).
        setConflict(data.currently_held_by ?? null);
        return;
      }
      if (!res.ok) throw new Error(data.error || "Failed to allocate asset");

      setNotice(`Asset allocated successfully.`);
      setHolderId("");
      setExpectedReturnDate("");
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to allocate asset");
    } finally {
      setAllocating(false);
    }
  }

  async function requestTransfer() {
    setError("");
    if (!transferToId) {
      setError("Select who the asset should transfer to");
      return;
    }
    setTransferring(true);
    try {
      const res = await fetch("/api/allocations/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: Number(assetId),
          toHolderId: Number(transferToId),
          reason: transferReason || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to transfer asset");

      setNotice(data.message || "Asset transferred successfully.");
      setConflict(null);
      setTransferToId("");
      setTransferReason("");
      setHolderId("");
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to transfer asset");
    } finally {
      setTransferring(false);
    }
  }

  async function markReturned(allocationId: number) {
    setError("");
    const condition = returnCondition[allocationId] || "GOOD";
    setSubmittingReturn(allocationId);
    try {
      const res = await fetch(`/api/allocations/${allocationId}/return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          condition,
          returnNotes: returnNotes[allocationId] || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to mark asset returned");

      setNotice("Asset marked as returned.");
      setReturningId(null);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mark asset returned");
    } finally {
      setSubmittingReturn(null);
    }
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-2">
          Allocation &amp; Transfer
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground">
          Manage asset allocation and transfer requests
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-600 dark:text-emerald-400">
          {notice}
        </div>
      )}

      {loading ? (
        <LoadingState message="Loading allocation data..." />
      ) : (
        <>
          {/* Allocate form */}
          <Card>
            <CardContent className="pt-6 space-y-4">
              <h2 className="text-lg font-semibold text-foreground">Allocate an Asset</h2>
              <div className="grid sm:grid-cols-3 gap-3">
                <select
                  value={assetId}
                  onChange={(e) => {
                    setAssetId(e.target.value);
                    setConflict(null);
                    setNotice("");
                  }}
                  className={cn(inputClass, "cursor-pointer")}
                >
                  <option value="">Select asset</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id} className="cursor-pointer">
                      {a.assetTag} — {a.name} ({a.status})
                    </option>
                  ))}
                </select>
                <select value={holderId} onChange={(e) => setHolderId(e.target.value)} className={cn(inputClass, "cursor-pointer")}>
                  <option value="">Select employee</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id} className="cursor-pointer"  >
                      {e.firstName} {e.lastName}
                      {e.departmentName ? ` (${e.departmentName})` : ""}
                    </option>
                  ))}
                </select>
                <input
                  type="date"
                  value={expectedReturnDate}
                  onChange={(e) => setExpectedReturnDate(e.target.value)}
                  className={inputClass}
                  title="Expected return date (optional)"
                />
              </div>

              {selectedAsset?.currentHolder && (
                <p className="text-sm text-muted-foreground">
                  Currently held by{" "}
                  <span className="text-foreground font-medium">
                    {selectedAsset.currentHolder.firstName} {selectedAsset.currentHolder.lastName}
                  </span>
                  .
                </p>
              )}

              <Button onClick={allocate} disabled={allocating} className="cursor-pointer">
                {allocating ? "Allocating..." : "Allocate Asset"}
              </Button>

              {/* Conflict banner + inline transfer request — the flagship demo moment */}
              {conflict && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 space-y-3">
                  <p className="text-sm text-destructive font-medium">
                    Already Allocated to {conflict.name} — direct re-allocation is blocked.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Allocated since {new Date(conflict.allocatedDate).toLocaleDateString()}. Submit a
                    transfer request instead:
                  </p>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <select
                      value={transferToId}
                      onChange={(e) => setTransferToId(e.target.value)}
                      className={inputClass}
                    >
                      <option value="">Transfer to...</option>
                      {employees.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.firstName} {e.lastName}
                        </option>
                      ))}
                    </select>
                    <input
                      placeholder="Reason (optional)"
                      value={transferReason}
                      onChange={(e) => setTransferReason(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <Button variant="destructive" onClick={requestTransfer} disabled={transferring}>
                    {transferring ? "Transferring..." : "Request Transfer"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Active allocations */}
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-3">Active Allocations</h2>
            {activeAllocations.length === 0 ? (
              <Card>
                <CardContent className="pt-6">
                  <EmptyState title="No active allocations" description="Allocate an asset above to get started." />
                </CardContent>
              </Card>
            ) : (
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 border-b border-border">
                      <tr>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Asset</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Holder</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Allocated</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Expected Return</th>
                        <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {activeAllocations.map((a) => {
                        const overdue =
                          a.expectedReturnDate && new Date(a.expectedReturnDate) < new Date();
                        return (
                          <Fragment key={a.id}>
                            <tr key={a.id}>
                              <td className="px-4 py-3 text-foreground font-medium">
                                {a.asset ? `${a.asset.assetTag} — ${a.asset.name}` : `#${a.assetId}`}
                              </td>
                              <td className="px-4 py-3 text-muted-foreground">
                                {a.holder ? `${a.holder.firstName} ${a.holder.lastName}` : "—"}
                              </td>
                              <td className="px-4 py-3 text-muted-foreground">
                                {new Date(a.allocatedDate).toLocaleDateString()}
                              </td>
                              <td className="px-4 py-3">
                                {a.expectedReturnDate ? (
                                  <Pill
                                    className={
                                      overdue
                                        ? "bg-destructive/15 text-destructive"
                                        : "bg-muted text-muted-foreground"
                                    }
                                  >
                                    {new Date(a.expectedReturnDate).toLocaleDateString()}
                                    {overdue ? " — Overdue" : ""}
                                  </Pill>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="cursor-pointer"
                                  onClick={() => setReturningId(returningId === a.id ? null : a.id)}
                                >
                                  {returningId === a.id ? "Cancel" : "Mark Returned"}
                                </Button>
                              </td>
                            </tr>
                            {returningId === a.id && (
                              <tr key={`${a.id}-return-form`}>
                                <td colSpan={5} className="px-4 py-3 bg-muted/30">
                                  <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
                                    <select
                                      value={returnCondition[a.id] || "GOOD"}
                                      onChange={(e) =>
                                        setReturnCondition({ ...returnCondition, [a.id]: e.target.value })
                                      }
                                      className={cn(inputClass, "cursor-pointer")}
                                    >
                                      <option value="GOOD">Good</option>
                                      <option value="FAIR">Fair</option>
                                      <option value="POOR">Poor</option>
                                    </select>
                                    <input
                                      placeholder="Return notes (optional)"
                                      value={returnNotes[a.id] || ""}
                                      onChange={(e) =>
                                        setReturnNotes({ ...returnNotes, [a.id]: e.target.value })
                                      }
                                      className={cn(inputClass, "flex-1 w-full")}
                                    />
                                    <Button
                                      size="sm"
                                      disabled={submittingReturn === a.id}
                                      onClick={() => markReturned(a.id)}
                                      className="cursor-pointer"
                                    >
                                      {submittingReturn === a.id ? "Submitting..." : "Confirm Return"}
                                    </Button>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>

          {/* Allocation history for the selected asset */}
          {assetId && (
            <div>
              <h2 className="text-lg font-semibold text-foreground mb-3">
                History — {selectedAsset ? `${selectedAsset.assetTag} ${selectedAsset.name}` : ""}
              </h2>
              {historyLoading ? (
                <LoadingState message="Loading history..." />
              ) : history.length === 0 ? (
                <Card>
                  <CardContent className="pt-6">
                    <EmptyState title="No history yet for this asset" />
                  </CardContent>
                </Card>
              ) : (
                <Card className="overflow-hidden">
                  <div className="divide-y divide-border">
                    {history.map((h) => (
                      <div key={h.id} className="px-4 py-3 flex justify-between items-center text-sm">
                        <div>
                          <span className="text-foreground font-medium">
                            {h.fromStatus ? `${h.fromStatus} → ${h.toStatus}` : h.toStatus}
                          </span>
                          {h.reason && <span className="text-muted-foreground"> — {h.reason}</span>}
                        </div>
                        <div className="text-muted-foreground text-xs text-right">
                          {h.actor ? `${h.actor.firstName} ${h.actor.lastName}` : "System"}
                          <br />
                          {new Date(h.createdAt).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}