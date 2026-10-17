"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState, EmptyState } from "@/components/ui";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────

type Category = { id: number; name: string; description: string | null };

type Asset = {
  id: number;
  assetTag: string;
  name: string;
  categoryId: number;
  category?: { name: string };
  serialNumber: string | null;
  condition: "GOOD" | "FAIR" | "POOR";
  location: string | null;
  isBookable: boolean;
  status:
    | "AVAILABLE"
    | "ALLOCATED"
    | "RESERVED"
    | "UNDER_MAINTENANCE"
    | "LOST"
    | "RETIRED"
    | "DISPOSED";
  notes: string | null;
  currentHolder?: { id: number; firstName: string; lastName: string } | null;
};

const STATUS_STYLES: Record<string, string> = {
  AVAILABLE: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  ALLOCATED: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  RESERVED: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  UNDER_MAINTENANCE: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  LOST: "bg-destructive/15 text-destructive",
  RETIRED: "bg-muted text-muted-foreground",
  DISPOSED: "bg-muted text-muted-foreground",
};

const STATUS_OPTIONS = [
  "AVAILABLE",
  "ALLOCATED",
  "RESERVED",
  "UNDER_MAINTENANCE",
  "LOST",
  "RETIRED",
  "DISPOSED",
] as const;

function Pill({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-block px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap", className)}>
      {children}
    </span>
  );
}

function SortableHeader({
  label,
  column,
}: {
  label: string;
  column: { toggleSorting: (desc?: boolean) => void; getIsSorted: () => false | "asc" | "desc" };
}) {
  return (
    <button
      className="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground transition-colors"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {label} <ArrowUpDown className="h-3.5 w-3.5" />
    </button>
  );
}

const inputClass =
  "h-10 px-3 rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-3 focus:ring-ring/50";

// ── Page ───────────────────────────────────────────────

export default function AssetsPage() {
  const { data: session } = useSession();
  const canRegister = session?.user?.role === "ADMIN" || session?.user?.role === "ASSET_MANAGER";

  const [assets, setAssets] = useState<Asset[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Server-side filters
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState("");
  // Client-side filter — the API filters tag/serial/name as separate,
  // AND-ed params, so a single free-text box is applied client-side across
  // all three after the server-side category/status filters come back.
  const [search, setSearch] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    categoryId: "",
    serialNumber: "",
    acquisitionDate: "",
    acquisitionCost: "",
    condition: "GOOD",
    location: "",
    isBookable: false,
    notes: "",
  });

  // TanStack Table sort state
  const [sorting, setSorting] = useState<SortingState>([]);

  async function refetch() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (categoryId) params.set("categoryId", categoryId);
      if (status) params.set("status", status);
      const [assetsRes, catRes] = await Promise.all([
        fetch(`/api/assets?${params}`),
        fetch("/api/asset-categories"),
      ]);
      const assetsData = await assetsRes.json();
      if (!assetsRes.ok) throw new Error(assetsData.message || assetsData.error || "Failed to load assets");
      setAssets(assetsData);
      setCategories(await catRes.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load assets");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, status]);

  const visibleAssets = useMemo(() => {
    if (!search.trim()) return assets;
    const q = search.trim().toLowerCase();
    return assets.filter(
      (a) =>
        a.assetTag.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        (a.serialNumber ?? "").toLowerCase().includes(q) ||
        (a.location ?? "").toLowerCase().includes(q)
    );
  }, [assets, search]);

  const columns = useMemo<ColumnDef<Asset>[]>(
    () => [
      {
        accessorKey: "assetTag",
        header: ({ column }) => <SortableHeader label="Tag" column={column} />,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.assetTag}</span>
        ),
      },
      {
        accessorKey: "name",
        header: ({ column }) => <SortableHeader label="Name" column={column} />,
        cell: ({ row }) => (
          <span className="font-medium text-foreground">
            {row.original.name}
            {row.original.isBookable && (
              <Pill className="ml-2 bg-primary/10 text-primary">Bookable</Pill>
            )}
          </span>
        ),
      },
      {
        id: "category",
        accessorFn: (a) => a.category?.name ?? "",
        header: "Category",
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.category?.name ?? "—"}</span>
        ),
      },
      {
        accessorKey: "status",
        header: ({ column }) => <SortableHeader label="Status" column={column} />,
        cell: ({ row }) => (
          <Pill className={STATUS_STYLES[row.original.status]}>
            {row.original.status.replace("_", " ")}
          </Pill>
        ),
      },
      {
        id: "holder",
        accessorFn: (a) =>
          a.currentHolder ? `${a.currentHolder.firstName} ${a.currentHolder.lastName}` : "",
        header: "Holder",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.currentHolder
              ? `${row.original.currentHolder.firstName} ${row.original.currentHolder.lastName}`
              : "—"}
          </span>
        ),
      },
      {
        accessorKey: "location",
        header: "Location",
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.location ?? "—"}</span>
        ),
      },
      {
        accessorKey: "condition",
        header: "Condition",
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.condition}</span>
        ),
      },
    ],
    []
  );

  const table = useReactTable({
    data: visibleAssets,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  async function registerAsset() {
    setError("");
    if (!form.name.trim()) {
      setError("Asset name is required");
      return;
    }
    if (!form.categoryId) {
      setError("Category is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          categoryId: Number(form.categoryId),
          serialNumber: form.serialNumber || undefined,
          acquisitionDate: form.acquisitionDate || undefined,
          acquisitionCost: form.acquisitionCost ? Number(form.acquisitionCost) : undefined,
          condition: form.condition,
          location: form.location || undefined,
          isBookable: form.isBookable,
          notes: form.notes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to register asset");
      setForm({
        name: "",
        categoryId: "",
        serialNumber: "",
        acquisitionDate: "",
        acquisitionCost: "",
        condition: "GOOD",
        location: "",
        isBookable: false,
        notes: "",
      });
      setShowForm(false);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to register asset");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-2">Asset Registry</h1>
        <p className="text-sm sm:text-base text-muted-foreground">
          Track all assets and their lifecycle status
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Search & filter */}
      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
            <input
              type="text"
              placeholder="Search by tag, name, serial, location..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={cn(inputClass, "flex-1")}
            />
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass}>
              <option value="">All Categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
              <option value="">All Statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
            {canRegister && (
              <Button className="sm:w-auto w-full" onClick={() => setShowForm((s) => !s)}>
                {showForm ? "Cancel" : "Register Asset"}
              </Button>
            )}
          </div>

          {showForm && canRegister && (
            <div className="rounded-lg border border-border p-4 space-y-3">
              <div className="grid sm:grid-cols-3 gap-3">
                <input
                  placeholder="Asset name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inputClass}
                />
                <select
                  value={form.categoryId}
                  onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                  className={inputClass}
                >
                  <option value="">Select category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  placeholder="Serial number (optional)"
                  value={form.serialNumber}
                  onChange={(e) => setForm({ ...form, serialNumber: e.target.value })}
                  className={inputClass}
                />
                <input
                  type="date"
                  placeholder="Acquisition date"
                  value={form.acquisitionDate}
                  onChange={(e) => setForm({ ...form, acquisitionDate: e.target.value })}
                  className={inputClass}
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Acquisition cost (optional)"
                  value={form.acquisitionCost}
                  onChange={(e) => setForm({ ...form, acquisitionCost: e.target.value })}
                  className={inputClass}
                />
                <select
                  value={form.condition}
                  onChange={(e) => setForm({ ...form, condition: e.target.value })}
                  className={inputClass}
                >
                  <option value="GOOD">Good</option>
                  <option value="FAIR">Fair</option>
                  <option value="POOR">Poor</option>
                </select>
                <input
                  placeholder="Location (optional)"
                  value={form.location}
                  onChange={(e) => setForm({ ...form, location: e.target.value })}
                  className={inputClass}
                />
                <input
                  placeholder="Notes (optional)"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className={cn(inputClass, "sm:col-span-2")}
                />
                <label className="flex items-center gap-2 text-sm text-foreground px-1">
                  <input
                    type="checkbox"
                    checked={form.isBookable}
                    onChange={(e) => setForm({ ...form, isBookable: e.target.checked })}
                    className="h-4 w-4 rounded border-border"
                  />
                  Shared / bookable resource
                </label>
              </div>
              <Button onClick={registerAsset} disabled={submitting}>
                {submitting ? "Registering..." : "Register Asset"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Table */}
      {loading ? (
        <LoadingState message="Loading assets..." />
      ) : visibleAssets.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title={assets.length === 0 ? "No assets registered yet" : "No assets match your search"}
              description={
                assets.length === 0
                  ? canRegister
                    ? "Register your first asset above."
                    : "Check back once an Asset Manager has registered some assets."
                  : "Try a different search term or clear the filters."
              }
            />
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}