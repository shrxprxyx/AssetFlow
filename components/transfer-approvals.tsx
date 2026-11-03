"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState, EmptyState } from "@/components/ui";
import { cn } from "@/lib/utils";

type Person = { id: number; name: string } | null;

type TransferRow = {
  id: number;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  reason: string | null;
  createdAt: string;
  asset: { id: number; assetTag: string; name: string };
  from: Person;
  to: Person;
  requestedBy: Person;
  canDecide: boolean;
  canCancel: boolean;
};

type AssetOption = {
  id: number;
  assetTag: string;
  name: string;
  currentHolder?: { id: number; firstName: string; lastName: string } | null;
};

const STATUS_STYLES: Record<TransferRow["status"], string> = {
  PENDING: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  APPROVED: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  REJECTED: "bg-destructive/15 text-destructive",
  CANCELLED: "bg-muted text-muted-foreground",
};

const inputClass =
  "h-10 px-3 rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-3 focus:ring-ring/50";

export function TransferApprovals({
  refreshKey = 0,
  onChanged,
}: {
  refreshKey?: number;
  onChanged?: (message?: string) => void;
}) {
  const { data: session } = useSession();
  const role = session?.user?.role ?? "EMPLOYEE";
  const myId = Number(session?.user?.id);

  const [rows, setRows] = useState<TransferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  // "Request an asset" form (employees)
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [assetId, setAssetId] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/transfers?status=ALL");
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Failed to load transfer requests");
      setRows(data.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load transfer requests");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (role !== "EMPLOYEE") return;
    fetch("/api/assets?status=ALLOCATED")
      .then((r) => r.json())
      .then((d) => setAssets(Array.isArray(d) ? d : []))
      .catch(() => setAssets([]));
  }, [role, refreshKey]);

  async function act(id: number, action: "approve" | "reject" | "cancel") {
    setError("");
    setNotice("");
    setBusyId(id);
    try {
      const res = await fetch(`/api/transfers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Something went wrong");
      const message =
        action === "approve"
          ? "Transfer approved. The asset has moved."
          : action === "reject"
            ? "Transfer rejected."
            : "Request cancelled.";
      setNotice(message);
      await load();
      onChanged?.(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      await load(); // the request may have been decided by someone else
    } finally {
      setBusyId(null);
    }
  }

  async function submitRequest() {
    setError("");
    setNotice("");
    if (!assetId) {
      setError("Pick the asset you need");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/allocations/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: Number(assetId),
          toHolderId: myId, // employees can only request an asset for themselves
          reason: reason || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Failed to submit request");
      const message = data.message || "Transfer request submitted.";
      setNotice(message);
      setAssetId("");
      setReason("");
      await load();
      onChanged?.(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit request");
    } finally {
      setSubmitting(false);
    }
  }

  const pendingCount = rows.filter((r) => r.status === "PENDING").length;
  const requestable = assets.filter((a) => a.currentHolder?.id !== myId);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-foreground">Transfer Requests</h2>
        {pendingCount > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            {pendingCount} pending
          </span>
        )}
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

      {role === "EMPLOYEE" && (
        <Card>
          <CardContent className="pt-6 space-y-3">
            <p className="text-sm text-muted-foreground">
              Need an asset someone else is holding? Ask for it here. A manager approves before it moves.
            </p>
            <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-3">
              <select value={assetId} onChange={(e) => setAssetId(e.target.value)} className={inputClass}>
                <option value="">Select an asset</option>
                {requestable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.assetTag} — {a.name}
                    {a.currentHolder ? ` (held by ${a.currentHolder.firstName} ${a.currentHolder.lastName})` : ""}
                  </option>
                ))}
              </select>
              <input
                placeholder="Reason (optional)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={inputClass}
              />
              <Button onClick={submitRequest} disabled={submitting}>
                {submitting ? "Submitting..." : "Request transfer"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <LoadingState message="Loading transfer requests..." />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="No transfer requests"
              description={
                role === "EMPLOYEE"
                  ? "Requests you make or receive will show up here."
                  : "Requests that need your decision will show up here."
              }
            />
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <div
                key={r.id}
                className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    {r.asset.assetTag} — {r.asset.name}
                  </p>
                  <p className="text-muted-foreground">
                    {r.from?.name ?? "Unassigned"} → {r.to?.name ?? "Unknown"}
                    <span className="mx-1.5">·</span>
                    requested by {r.requestedBy?.name ?? "Unknown"}
                    <span className="mx-1.5">·</span>
                    {new Date(r.createdAt).toLocaleDateString()}
                  </p>
                  {r.reason && <p className="text-muted-foreground italic">&ldquo;{r.reason}&rdquo;</p>}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={cn(
                      "inline-block px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap",
                      STATUS_STYLES[r.status]
                    )}
                  >
                    {r.status}
                  </span>
                  {r.canDecide && (
                    <>
                      <Button size="sm" disabled={busyId === r.id} onClick={() => act(r.id, "approve")}>
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === r.id}
                        onClick={() => act(r.id, "reject")}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                  {r.canCancel && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === r.id}
                      onClick={() => act(r.id, "cancel")}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
