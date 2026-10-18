"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type MaintenanceRequest = {
  id: number;
  assetId: number;
  description: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "PENDING" | "APPROVED" | "REJECTED" | "IN_PROGRESS" | "RESOLVED";
  technicianId: number | null;
  resolutionNotes: string | null;
  asset: { assetTag: string; name: string };
  requester: { firstName: string; lastName: string };
};

type AssetOption = { id: number; assetTag: string; name: string; status: string };

const PRIORITY_STYLES: Record<string, string> = {
  LOW: "bg-muted text-muted-foreground",
  MEDIUM: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  HIGH: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  CRITICAL: "bg-destructive/15 text-destructive",
};

type Stage = "PENDING" | "APPROVED" | "TECHNICIAN_ASSIGNED" | "IN_PROGRESS" | "RESOLVED";

const COLUMNS: { stage: Stage; title: string }[] = [
  { stage: "PENDING", title: "Pending" },
  { stage: "APPROVED", title: "Approved" },
  { stage: "TECHNICIAN_ASSIGNED", title: "Technician Assigned" },
  { stage: "IN_PROGRESS", title: "In Progress" },
  { stage: "RESOLVED", title: "Resolved" },
];

function stageOf(r: MaintenanceRequest): Stage | "REJECTED" {
  if (r.status === "PENDING") return "PENDING";
  if (r.status === "REJECTED") return "REJECTED";
  if (r.status === "APPROVED") return r.technicianId ? "TECHNICIAN_ASSIGNED" : "APPROVED";
  if (r.status === "IN_PROGRESS") return "IN_PROGRESS";
  return "RESOLVED";
}

export default function MaintenancePage() {
  const { data: session } = useSession();
  const isManager = session?.user?.role === "ASSET_MANAGER" || session?.user?.role === "ADMIN";

  const [requests, setRequests] = useState<MaintenanceRequest[]>([]);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [form, setForm] = useState({ assetId: "", description: "", priority: "MEDIUM" });
  const [submitting, setSubmitting] = useState(false);

  // Per-card ephemeral inputs (technician id to assign, resolution notes to resolve)
  const [technicianInputs, setTechnicianInputs] = useState<Record<number, string>>({});
  const [resolutionInputs, setResolutionInputs] = useState<Record<number, string>>({});
  const [actingOn, setActingOn] = useState<number | null>(null);

  async function refetch() {
    setLoading(true);
    try {
      const res = await fetch("/api/maintenance-requests");
      const data = await res.json();
      setRequests(data.data ?? []);
      setAssets(data.assets ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refetch();
  }, []);

  async function raiseRequest() {
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/maintenance-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: Number(form.assetId),
          description: form.description,
          priority: form.priority,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Couldn't raise the request");
        return;
      }
      setForm({ assetId: "", description: "", priority: "MEDIUM" });
      refetch();
    } finally {
      setSubmitting(false);
    }
  }

  async function patchRequest(id: number, body: Record<string, unknown>) {
    setError("");
    setActingOn(id);
    try {
      const res = await fetch(`/api/maintenance-requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "That transition failed");
        return;
      }
      refetch();
    } finally {
      setActingOn(null);
    }
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-2">
          Maintenance Management
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground">
          Manage maintenance requests through approval workflow
        </p>
      </div>

      {/* Raise request */}
      <Card>
        <CardContent className="pt-6">
          <h2 className="text-sm font-semibold text-foreground mb-3">Raise a request</h2>
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
            <select
              value={form.assetId}
              onChange={(e) => setForm({ ...form, assetId: e.target.value })}
              className="h-10 cursor-pointer rounded-lg border border-border bg-background px-3 text-sm text-foreground w-full sm:w-56"
            >
              <option value="">Select asset</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id} className="cursor-pointer">
                  {a.assetTag} — {a.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Describe the issue…"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="h-10 flex-1 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
            />
            <select
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              className="h-10 cursor-pointer rounded-lg border border-border bg-background px-3 text-sm text-foreground w-full sm:w-36"
            >
              <option value="LOW" className="cursor-pointer">Low</option>
              <option value="MEDIUM" className="cursor-pointer">Medium</option>
              <option value="HIGH" className="cursor-pointer">High</option>
              <option value="CRITICAL" className="cursor-pointer">Critical</option>
            </select>
            <Button
              onClick={raiseRequest}
              disabled={submitting || !form.assetId || !form.description}
              className="w-full sm:w-auto cursor-pointer"
            >
              {submitting ? "Raising…" : "Raise Request"}
            </Button>
          </div>
          {error && <p className="text-sm text-destructive mt-3">{error}</p>}
        </CardContent>
      </Card>

      {/* Kanban board */}
      {loading ? (
        <p className="text-muted-foreground text-sm">Loading requests…</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
          {COLUMNS.map((col) => {
            const cardsInColumn = requests.filter((r) => stageOf(r) === col.stage);
            return (
              <div key={col.stage} className="space-y-3">
                <div className="flex items-center justify-between px-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {col.title}
                  </h3>
                  <span className="text-xs text-muted-foreground">{cardsInColumn.length}</span>
                </div>

                <div className="space-y-3">
                  {cardsInColumn.map((r) => (
                    <Card key={r.id} className="p-4">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <span className="text-sm font-medium text-foreground">
                          {r.asset.assetTag} — {r.asset.name}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                            PRIORITY_STYLES[r.priority]
                          )}
                        >
                          {r.priority}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mb-2">{r.description}</p>
                      <p className="text-xs text-muted-foreground mb-3">
                        Raised by {r.requester.firstName} {r.requester.lastName}
                      </p>

                      {isManager && col.stage === "PENDING" && (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={actingOn === r.id}
                            onClick={() => patchRequest(r.id, { status: "APPROVED" })}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={actingOn === r.id}
                            onClick={() => patchRequest(r.id, { status: "REJECTED" })}
                          >
                            Reject
                          </Button>
                        </div>
                      )}

                      {isManager && col.stage === "APPROVED" && (
                        <div className="flex gap-2">
                          <input
                            type="number"
                            placeholder="Technician user ID"
                            value={technicianInputs[r.id] ?? ""}
                            onChange={(e) =>
                              setTechnicianInputs({ ...technicianInputs, [r.id]: e.target.value })
                            }
                            className="h-8 flex-1 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                          />
                          <Button
                            size="sm"
                            disabled={actingOn === r.id || !technicianInputs[r.id]}
                            onClick={() =>
                              patchRequest(r.id, { technicianId: Number(technicianInputs[r.id]) })
                            }
                          >
                            Assign
                          </Button>
                        </div>
                      )}

                      {isManager && col.stage === "TECHNICIAN_ASSIGNED" && (
                        <Button
                          size="sm"
                          disabled={actingOn === r.id}
                          onClick={() => patchRequest(r.id, { status: "IN_PROGRESS" })}
                        >
                          Start Work
                        </Button>
                      )}

                      {isManager && col.stage === "IN_PROGRESS" && (
                        <div className="flex flex-col gap-2">
                          <textarea
                            placeholder="Resolution notes…"
                            value={resolutionInputs[r.id] ?? ""}
                            onChange={(e) =>
                              setResolutionInputs({ ...resolutionInputs, [r.id]: e.target.value })
                            }
                            className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground resize-none"
                            rows={2}
                          />
                          <Button
                            size="sm"
                            disabled={actingOn === r.id}
                            onClick={() =>
                              patchRequest(r.id, {
                                status: "RESOLVED",
                                resolutionNotes: resolutionInputs[r.id] || undefined,
                              })
                            }
                          >
                            Resolve
                          </Button>
                        </div>
                      )}

                      {col.stage === "RESOLVED" && r.resolutionNotes && (
                        <p className="text-xs text-muted-foreground italic">"{r.resolutionNotes}"</p>
                      )}
                    </Card>
                  ))}

                  {cardsInColumn.length === 0 && (
                    <p className="text-xs text-muted-foreground/70 px-1">No requests</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
