"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown, QrCode, ScanLine } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState, EmptyState } from "@/components/ui";
import { Pager } from "@/components/pager";
import { PhotoField } from "@/components/photo-field";
import { AssetQrDialog } from "@/components/asset-qr-dialog";
import { QrScanner } from "@/components/qr-scanner";
import { tagFromScan } from "@/lib/qr";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────

type Category = { id: number; name: string; description: string | null };
type Department = { id: number; name: string; status: "ACTIVE" | "INACTIVE" };

type AssetStatus =
  | "AVAILABLE"
  | "ALLOCATED"
  | "RESERVED"
  | "UNDER_MAINTENANCE"
  | "LOST"
  | "RETIRED"
  | "DISPOSED";

type Asset = {
  id: number;
  assetTag: string;
  name: string;
  categoryId: number;
  category?: { name: string };
  departmentId?: number | null;
  department?: { id: number; name: string } | null;
  serialNumber: string | null;
  acquisitionDate: string | null;
  acquisitionCost: number | null;
  condition: "GOOD" | "FAIR" | "POOR";
  location: string | null;
  isBookable: boolean;
  status: AssetStatus;
  notes: string | null;
  photoUrl?: string | null;
  currentHolder?: { id: number; firstName: string; lastName: string } | null;
};

type FormState = {
  name: string;
  categoryId: string;
  departmentId: string;
  serialNumber: string;
  acquisitionDate: string;
  acquisitionCost: string;
  condition: string;
  location: string;
  isBookable: boolean;
  notes: string;
  photoUrl: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  categoryId: "",
  departmentId: "",
  serialNumber: "",
  acquisitionDate: "",
  acquisitionCost: "",
  condition: "GOOD",
  location: "",
  isBookable: false,
  notes: "",
  photoUrl: "",
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

// ── Lifecycle actions (mirror the server's allowed moves) ──

type Target = "LOST" | "RETIRED" | "DISPOSED" | "AVAILABLE";
type LifecycleAction = { target: Target; label: string; danger?: boolean };

const MARK_LOST: LifecycleAction = { target: "LOST", label: "Mark lost", danger: true };

const LIFECYCLE_ACTIONS: Record<AssetStatus, LifecycleAction[]> = {
  AVAILABLE: [{ target: "RETIRED", label: "Retire" }, MARK_LOST],
  ALLOCATED: [MARK_LOST],
  RESERVED: [MARK_LOST],
  UNDER_MAINTENANCE: [MARK_LOST],
  LOST: [{ target: "AVAILABLE", label: "Mark found" }],
  RETIRED: [{ target: "DISPOSED", label: "Dispose", danger: true }],
  DISPOSED: [],
};

const CONFIRM_COPY: Record<Target, string> = {
  LOST: "Any active allocation will be closed and upcoming bookings cancelled.",
  RETIRED: "It will no longer be allocatable or bookable, and upcoming bookings will be cancelled.",
  DISPOSED: "This is final — a disposed asset can't be changed or edited again.",
  AVAILABLE: "It will go back into service.",
};

const TARGET_VERB: Record<Target, string> = {
  LOST: "Mark as lost",
  RETIRED: "Retire",
  DISPOSED: "Dispose of",
  AVAILABLE: "Mark as found:",
};

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

// Rows per page in the directory table.
const PAGE_SIZE = 25;

const inputClass =
  "h-10 px-3 rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-3 focus:ring-ring/50";

// The same fields are used to register a new asset and to edit an existing one.
function AssetFormFields({
  form,
  setForm,
  categories,
  departments,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  categories: Category[];
  departments: Department[];
}) {
  return (
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
      <select
        value={form.departmentId}
        onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
        className={inputClass}
        aria-label="Owning department"
      >
        <option value="">No owning department</option>
        {departments.map((d) => (
          // An inactive department can't be newly assigned; keep it listed only if already chosen.
          <option
            key={d.id}
            value={d.id}
            disabled={d.status !== "ACTIVE" && String(d.id) !== form.departmentId}
          >
            {d.name}
            {d.status !== "ACTIVE" ? " (inactive)" : ""}
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
      <PhotoField
        value={form.photoUrl}
        onChange={(photoUrl) => setForm({ ...form, photoUrl })}
        className="sm:col-span-3"
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
  );
}

// Works out which fields the person actually changed, so the edit request only
// contains those (and can't accidentally overwrite anything else).
function buildPatch(orig: Asset, f: FormState): { patch: Record<string, unknown>; error?: string } {
  const patch: Record<string, unknown> = {};

  const name = f.name.trim();
  if (!name) return { patch, error: "Asset name is required" };
  if (name !== orig.name) patch.name = name;

  const categoryId = Number(f.categoryId);
  if (!categoryId) return { patch, error: "Category is required" };
  if (categoryId !== orig.categoryId) patch.categoryId = categoryId;

  const departmentId = f.departmentId === "" ? null : Number(f.departmentId);
  if (departmentId !== (orig.departmentId ?? null)) patch.departmentId = departmentId;

  const setText = (key: string, value: string, original: string | null) => {
    const next = value.trim();
    if (next !== (original ?? "")) patch[key] = next === "" ? null : next;
  };
  setText("serialNumber", f.serialNumber, orig.serialNumber);
  setText("location", f.location, orig.location);
  setText("notes", f.notes, orig.notes);
  setText("photoUrl", f.photoUrl, orig.photoUrl ?? null);

  if (f.acquisitionDate !== (orig.acquisitionDate ?? "").slice(0, 10)) {
    patch.acquisitionDate = f.acquisitionDate || null;
  }

  const cost = f.acquisitionCost === "" ? null : Number(f.acquisitionCost);
  if (cost !== null && (Number.isNaN(cost) || cost < 0)) {
    return { patch, error: "Acquisition cost must be a positive number" };
  }
  if (cost !== (orig.acquisitionCost ?? null)) patch.acquisitionCost = cost;

  if (f.condition !== orig.condition) patch.condition = f.condition;
  if (f.isBookable !== orig.isBookable) patch.isBookable = f.isBookable;

  return { patch };
}

// ── Page ───────────────────────────────────────────────

export default function AssetsPage() {
  const { data: session } = useSession();
  const canManage = session?.user?.role === "ADMIN" || session?.user?.role === "ASSET_MANAGER";

  const [assets, setAssets] = useState<Asset[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Server-side filters
  const [categoryId, setCategoryId] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [status, setStatus] = useState("");
  // The search box is also server-side (?q=), so it searches every asset, not
  // just the page on screen. `search` is what's typed; `query` is what was
  // last sent, a moment after typing stops.
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  // QR labels: print one for an asset, or scan one to jump to it.
  const [qrAsset, setQrAsset] = useState<Asset | null>(null);
  const [scanning, setScanning] = useState(false);

  // Paging
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  // Each load gets a number, so a slow older response can't overwrite a newer one.
  const loadSeq = useRef(0);

  // Register
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Edit
  const [editing, setEditing] = useState<Asset | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Lost / found / retire / dispose
  const [pending, setPending] = useState<{ asset: Asset; target: Target } | null>(null);
  const [reason, setReason] = useState("");
  const [acting, setActing] = useState(false);

  // TanStack Table sort state
  const [sorting, setSorting] = useState<SortingState>([]);

  async function refetch() {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (categoryId) params.set("categoryId", categoryId);
      if (departmentFilter) params.set("departmentId", departmentFilter);
      if (status) params.set("status", status);
      if (query) params.set("q", query);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      const [assetsRes, catRes, deptRes] = await Promise.all([
        fetch(`/api/assets?${params}`),
        fetch("/api/asset-categories"),
        fetch("/api/departments"),
      ]);
      const assetsData = await assetsRes.json();
      const categoriesData = await catRes.json();
      // The department list only feeds the picker and the filter; if it fails,
      // the assets still load and the pickers are just empty.
      const departmentsData = deptRes.ok ? await deptRes.json() : [];
      if (seq !== loadSeq.current) return; // a newer load has started
      if (!assetsRes.ok) throw new Error(assetsData.message || assetsData.error || "Failed to load assets");

      const rows: Asset[] = assetsData.data ?? [];
      const count: number = assetsData.total ?? 0;
      // The page we were on no longer exists (e.g. the list shrank): go to the last one.
      if (rows.length === 0 && count > 0 && page > 1) {
        setPage(Math.ceil(count / PAGE_SIZE));
        return;
      }
      setAssets(rows);
      setTotal(count);
      setCategories(categoriesData);
      setDepartments(Array.isArray(departmentsData) ? departmentsData : []);
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : "Failed to load assets");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, departmentFilter, status, query, page]);

  // A QR label opens /assets?tag=AF-0001: search for that tag straight away.
  useEffect(() => {
    const tag = new URLSearchParams(window.location.search).get("tag")?.trim();
    if (tag) setSearch(tag);
  }, []);

  function onScanned(text: string) {
    setScanning(false);
    const tag = tagFromScan(text);
    if (!tag) {
      setNotice("");
      setError("That QR code isn't an AssetFlow asset label.");
      return;
    }
    setError("");
    setSearch(tag);
  }

  // Send the search a moment after typing stops, and start again from page 1.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const startEdit = useCallback((a: Asset) => {
    setShowForm(false);
    setPending(null);
    setError("");
    setNotice("");
    setEditForm({
      name: a.name,
      categoryId: String(a.categoryId),
      departmentId: a.departmentId == null ? "" : String(a.departmentId),
      serialNumber: a.serialNumber ?? "",
      acquisitionDate: (a.acquisitionDate ?? "").slice(0, 10),
      acquisitionCost: a.acquisitionCost == null ? "" : String(a.acquisitionCost),
      condition: a.condition,
      location: a.location ?? "",
      isBookable: a.isBookable,
      notes: a.notes ?? "",
      photoUrl: a.photoUrl ?? "",
    });
    setEditing(a);
  }, []);

  const startStatusChange = useCallback((asset: Asset, target: Target) => {
    setShowForm(false);
    setEditing(null);
    setError("");
    setNotice("");
    setReason("");
    setPending({ asset, target });
  }, []);

  // Search, category and status are all applied by the server now.
  const visibleAssets = assets;
  const hasFilters = Boolean(query || categoryId || departmentFilter || status);

  const columns = useMemo<ColumnDef<Asset>[]>(() => {
    const base: ColumnDef<Asset>[] = [
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
            {row.original.photoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={row.original.photoUrl}
                alt=""
                className="mr-2 inline-block h-6 w-6 rounded border border-border object-cover align-middle"
              />
            )}
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
        id: "department",
        accessorFn: (a) => a.department?.name ?? "",
        header: "Department",
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.department?.name ?? "—"}</span>
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
    ];

    // Anyone can open an asset's label; only managers get the edit and lifecycle actions.
    const withQr: ColumnDef<Asset>[] = [
      ...base,
      {
        id: "qr",
        header: "QR",
        enableSorting: false,
        cell: ({ row }) => (
          <Button
            size="xs"
            variant="outline"
            className="cursor-pointer"
            title="Show this asset's QR label"
            onClick={() => setQrAsset(row.original)}
          >
            <QrCode className="h-3.5 w-3.5" />
            QR
          </Button>
        ),
      },
    ];

    if (!canManage) return withQr;

    return [
      ...withQr,
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }) => {
          const a = row.original;
          // A disposed asset is final: nothing can be done to it any more.
          if (a.status === "DISPOSED") return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" variant="outline" className="cursor-pointer" onClick={() => startEdit(a)}>
                Edit
              </Button>
              {LIFECYCLE_ACTIONS[a.status].map((act) => (
                <Button
                  key={act.target}
                  size="xs"
                  variant={act.danger ? "destructive" : "outline"}
                  className="cursor-pointer"
                  onClick={() => startStatusChange(a, act.target)}
                >
                  {act.label}
                </Button>
              ))}
            </div>
          );
        },
      },
    ];
  }, [canManage, startEdit, startStatusChange]);

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
    setNotice("");
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
          departmentId: form.departmentId ? Number(form.departmentId) : null,
          serialNumber: form.serialNumber || undefined,
          acquisitionDate: form.acquisitionDate || undefined,
          acquisitionCost: form.acquisitionCost ? Number(form.acquisitionCost) : undefined,
          condition: form.condition,
          location: form.location || undefined,
          isBookable: form.isBookable,
          notes: form.notes || undefined,
          photoUrl: form.photoUrl || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Failed to register asset");
      setForm(EMPTY_FORM);
      setShowForm(false);
      setNotice(`Registered ${data.assetTag}.`);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to register asset");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setError("");
    const { patch, error: problem } = buildPatch(editing, editForm);
    if (problem) {
      setError(problem);
      return;
    }
    if (Object.keys(patch).length === 0) {
      setError("No changes to save");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/assets/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Failed to save changes");
      setNotice(`Saved changes to ${editing.assetTag}.`);
      setEditing(null);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  async function confirmStatusChange() {
    if (!pending) return;
    setError("");
    setActing(true);
    try {
      const res = await fetch(`/api/assets/${pending.asset.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: pending.target, reason: reason.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Failed to change status");

      const cancelled: number = data.cancelledBookings ?? 0;
      setNotice(
        `${pending.asset.assetTag} is now ${String(data.asset.status).toLowerCase().replace("_", " ")}.` +
          (cancelled > 0 ? ` ${cancelled} upcoming booking(s) were cancelled.` : "")
      );
      setPending(null);
      setReason("");
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change status");
    } finally {
      setActing(false);
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
      {notice && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-600 dark:text-emerald-400">
          {notice}
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
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              title="Scan an asset's QR label"
              onClick={() => setScanning(true)}
            >
              <ScanLine className="h-4 w-4" />
              Scan
            </Button>
            <select
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setPage(1);
              }}
              className={cn(inputClass, "cursor-pointer")}
            >
              <option value="">All Categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id} className="cursor-pointer">
                  {c.name}
                </option>
              ))}
            </select>
            <select
              value={departmentFilter}
              onChange={(e) => {
                setDepartmentFilter(e.target.value);
                setPage(1);
              }}
              className={cn(inputClass, "cursor-pointer")}
              aria-label="Filter by owning department"
            >
              <option value="">All Departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id} className="cursor-pointer">
                  {d.name}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className={cn(inputClass, "cursor-pointer")}
            >
              <option value="">All Statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s} className="cursor-pointer">
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
            {canManage && (
              <Button
                className="sm:w-auto w-full cursor-pointer"
                onClick={() => {
                  setEditing(null);
                  setPending(null);
                  setNotice("");
                  setShowForm((s) => !s);
                }}
              >
                {showForm ? "Cancel" : "Register Asset"}
              </Button>
            )}
          </div>

          {showForm && canManage && (
            <div className="rounded-lg border border-border p-4 space-y-3">
              <AssetFormFields form={form} setForm={setForm} categories={categories} departments={departments} />
              <Button onClick={registerAsset} disabled={submitting}>
                {submitting ? "Registering..." : "Register Asset"}
              </Button>
            </div>
          )}

          {editing && canManage && (
            <div className="rounded-lg border border-primary/40 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground">
                Editing <span className="font-mono">{editing.assetTag}</span>
              </p>
              <AssetFormFields form={editForm} setForm={setEditForm} categories={categories} departments={departments} />
              <div className="flex gap-2">
                <Button onClick={saveEdit} disabled={saving} className="cursor-pointer">
                  {saving ? "Saving..." : "Save changes"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setEditing(null)}
                  disabled={saving}
                  className="cursor-pointer"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {pending && canManage && (
            <div
              className={cn(
                "rounded-lg border p-4 space-y-3",
                pending.target === "AVAILABLE" || pending.target === "RETIRED"
                  ? "border-border"
                  : "border-destructive/40 bg-destructive/5"
              )}
            >
              <div>
                <p className="text-sm font-medium text-foreground">
                  {TARGET_VERB[pending.target]}{" "}
                  <span className="font-mono">{pending.asset.assetTag}</span> — {pending.asset.name}?
                </p>
                <p className="text-sm text-muted-foreground">{CONFIRM_COPY[pending.target]}</p>
              </div>
              <input
                placeholder="Reason (optional)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                className={cn(inputClass, "w-full")}
              />
              <div className="flex gap-2">
                <Button
                  variant={pending.target === "AVAILABLE" || pending.target === "RETIRED" ? "default" : "destructive"}
                  onClick={confirmStatusChange}
                  disabled={acting}
                  className="cursor-pointer"
                >
                  {acting ? "Working..." : "Confirm"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setPending(null)}
                  disabled={acting}
                  className="cursor-pointer"
                >
                  Cancel
                </Button>
              </div>
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
              title={!hasFilters ? "No assets registered yet" : "No assets match your search"}
              description={
                !hasFilters
                  ? canManage
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

      {/* Column sorting applies to the page on screen. */}
      <Pager page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} disabled={loading} noun="assets" />

      {qrAsset && <AssetQrDialog asset={qrAsset} onClose={() => setQrAsset(null)} />}
      {scanning && <QrScanner onResult={onScanned} onClose={() => setScanning(false)} />}
    </div>
  );
}