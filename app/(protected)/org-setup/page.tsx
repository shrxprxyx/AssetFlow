"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState, EmptyState } from "@/components/ui";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────

type Department = {
  id: number;
  name: string;
  description: string | null;
  parentDeptId: number | null;
  headId: number | null;
  status: "ACTIVE" | "INACTIVE";
  head?: { id: number; firstName: string; lastName: string } | null;
};

type Category = {
  id: number;
  name: string;
  description: string | null;
};

type Employee = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  departmentId: number | null;
  departmentName?: string;
  role: "ADMIN" | "ASSET_MANAGER" | "DEPARTMENT_HEAD" | "EMPLOYEE";
  status: "ACTIVE" | "INACTIVE";
};

const TABS = ["Departments", "Asset Categories", "Employees"] as const;
type Tab = (typeof TABS)[number];

const ROLE_STYLES: Record<string, string> = {
  ADMIN: "bg-primary/15 text-primary",
  ASSET_MANAGER: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  DEPARTMENT_HEAD: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  EMPLOYEE: "bg-muted text-muted-foreground",
};

function Pill({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-block px-2.5 py-1 rounded-full text-xs font-medium", className)}>
      {children}
    </span>
  );
}

// ── Page ───────────────────────────────────────────────

export default function OrganizationSetupPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";

  const [tab, setTab] = useState<Tab>("Departments");

  if (!isAdmin) {
    return (
      <EmptyState
        title="Admins only"
        description="Organization Setup is restricted to Admin accounts."
      />
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-2">
          Organization Setup
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground">
          Admin only: Manage departments, categories, and employees
        </p>
      </div>

      <Card className="overflow-hidden">
        <div className="flex gap-4 overflow-x-auto items-end px-6 pt-4 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "shrink-0 px-4 pb-3 pt-1 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer",
                tab === t
                  ? "text-foreground border-primary"
                  : "text-muted-foreground border-transparent hover:text-foreground"
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <CardContent className="pt-6">
          {tab === "Departments" && <DepartmentsTab />}
          {tab === "Asset Categories" && <CategoriesTab />}
          {tab === "Employees" && <EmployeesTab />}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Departments Tab ──────────────────────────────────────

function DepartmentsTab() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    name: "",
    description: "",
    headId: "",
    parentDeptId: "",
  });

  async function refetch() {
    setLoading(true);
    try {
      const [deptRes, empRes] = await Promise.all([
        fetch("/api/departments"),
        fetch("/api/employees"),
      ]);
      setDepartments(await deptRes.json());
      setEmployees(await empRes.json());
    } catch {
      setError("Failed to load departments");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refetch();
  }, []);

  async function createDepartment() {
    setError("");
    if (!form.name.trim()) {
      setError("Department name is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          description: form.description || undefined,
          headId: form.headId ? Number(form.headId) : undefined,
          parentDeptId: form.parentDeptId ? Number(form.parentDeptId) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create department");
      setForm({ name: "", description: "", headId: "", parentDeptId: "" });
      setShowForm(false);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create department");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleStatus(dept: Department) {
    setError("");
    try {
      if (dept.status === "ACTIVE") {
        // Soft-deactivate — API sets status to INACTIVE (blocked server-side
        // if the department has child departments or employees)
        const res = await fetch("/api/departments", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: dept.id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to deactivate department");
      } else {
        const res = await fetch("/api/departments", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: dept.id, status: "ACTIVE" }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to reactivate department");
      }
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update department");
    }
  }

  if (loading) return <LoadingState message="Loading departments..." />;

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">
          {departments.length} department{departments.length !== 1 ? "s" : ""}
        </p>
        <Button className="cursor-pointer" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "+ Add Department"}
        </Button>
      </div>

      {showForm && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <input
              placeholder="Department name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="h-10 px-3 rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-3 focus:ring-ring/50"
            />
            <input
              placeholder="Description (optional)"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="h-10 px-3 rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-3 focus:ring-ring/50"
            />
            <select
              value={form.headId}
              onChange={(e) => setForm({ ...form, headId: e.target.value })}
              className="h-10 px-3 rounded-lg bg-background border border-border text-foreground focus:outline-none focus:ring-3 focus:ring-ring/50"
            >
              <option value="">Department Head (optional)</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.firstName} {e.lastName}
                </option>
              ))}
            </select>
            <select
              value={form.parentDeptId}
              onChange={(e) => setForm({ ...form, parentDeptId: e.target.value })}
              className="h-10 px-3 rounded-lg bg-background border border-border text-foreground focus:outline-none focus:ring-3 focus:ring-ring/50"
            >
              <option value="">Parent Department (optional)</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <Button className='cursor-pointer' onClick={createDepartment} disabled={submitting}>
            {submitting ? "Creating..." : "Create Department"}
          </Button>
        </div>
      )}

      {departments.length === 0 ? (
        <EmptyState title="No departments yet" description="Add your first department above." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Head</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Parent</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {departments.map((d) => (
                <tr key={d.id}>
                  <td className="px-4 py-3 text-foreground font-medium">{d.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {d.head ? `${d.head.firstName} ${d.head.lastName}` : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {departments.find((p) => p.id === d.parentDeptId)?.name ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Pill
                      className={
                        d.status === "ACTIVE"
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : "bg-muted text-muted-foreground"
                      }
                    >
                      {d.status}
                    </Pill>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="outline" className='cursor-pointer' size="sm" onClick={() => toggleStatus(d)}>
                      {d.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Asset Categories Tab ─────────────────────────────────

function CategoriesTab() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });

  async function refetch() {
    setLoading(true);
    try {
      const res = await fetch("/api/asset-categories");
      setCategories(await res.json());
    } catch {
      setError("Failed to load categories");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refetch();
  }, []);

  async function createCategory() {
    setError("");
    if (!form.name.trim()) {
      setError("Category name is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/asset-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          description: form.description || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create category");
      setForm({ name: "", description: "" });
      setShowForm(false);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create category");
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteCategory(id: number) {
    setError("");
    try {
      const res = await fetch("/api/asset-categories", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete category");
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete category");
    }
  }

  if (loading) return <LoadingState message="Loading categories..." />;

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">
          {categories.length} categor{categories.length !== 1 ? "ies" : "y"}
        </p>
        <Button className='cursor-pointer' onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "+ Add Category"}
        </Button>
      </div>

      {showForm && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <input
              placeholder="Category name (e.g. Electronics)"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="h-10 px-3 rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-3 focus:ring-ring/50"
            />
            <input
              placeholder="Description (optional)"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="h-10 px-3 rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-3 focus:ring-ring/50"
            />
          </div>
          <Button className='cursor-pointer' onClick={createCategory} disabled={submitting}>
            {submitting ? "Creating..." : "Create Category"}
          </Button>
        </div>
      )}

      {categories.length === 0 ? (
        <EmptyState title="No categories yet" description="Add your first asset category above." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Description</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {categories.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-3 text-foreground font-medium">{c.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.description || "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <Button className='cursor-pointer' variant="destructive" size="sm" onClick={() => deleteCategory(c.id)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Employees Tab ────────────────────────────────────────

function EmployeesTab() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [roleChoice, setRoleChoice] = useState<Record<number, string>>({});

  async function refetch() {
    setLoading(true);
    try {
      const [empRes, deptRes] = await Promise.all([
        fetch("/api/employees"),
        fetch("/api/departments"),
      ]);
      setEmployees(await empRes.json());
      setDepartments(await deptRes.json());
    } catch {
      setError("Failed to load employees");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refetch();
  }, []);

  async function send(id: number, url: string, method: string, body: unknown) {
    setError("");
    setBusyId(id);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Request failed");
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <LoadingState message="Loading employees..." />;

  const activeDepartments = departments.filter((d) => d.status === "ACTIVE");

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        {employees.length} employee{employees.length !== 1 ? "s" : ""}. Assign departments, change roles,
        and activate or deactivate accounts. Admin accounts can't be changed here.
      </p>

      {employees.length === 0 ? (
        <EmptyState title="No employees yet" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Email</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Department</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Role</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {employees.map((e) => {
                const isAdmin = e.role === "ADMIN";
                const busy = busyId === e.id;
                const currentRole = e.role;
                const chosen = roleChoice[e.id] ?? currentRole;
                return (
                  <tr key={e.id}>
                    <td className="px-4 py-3 text-foreground font-medium">
                      {e.firstName} {e.lastName}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{e.email}</td>
                    <td className="px-4 py-3">
                      {isAdmin ? (
                        <span className="text-muted-foreground">{e.departmentName ?? "—"}</span>
                      ) : (
                        <select
                          value={e.departmentId ?? ""}
                          disabled={busy}
                          onChange={(ev) =>
                            send(
                              e.id,
                              `/api/employees/${e.id}/department`,
                              "POST",
                              { departmentId: ev.target.value ? Number(ev.target.value) : null }
                            )
                          }
                          className="h-8 px-2 rounded-lg bg-background border border-border text-foreground text-xs focus:outline-none focus:ring-3 focus:ring-ring/50"
                        >
                          <option value="">No department</option>
                          {activeDepartments.map((d) => (
                            <option key={d.id} value={d.id}>{d.name}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Pill className={ROLE_STYLES[e.role]}>{e.role.replace("_", " ")}</Pill>
                    </td>
                    <td className="px-4 py-3">
                      <Pill
                        className={
                          e.status === "ACTIVE"
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : "bg-muted text-muted-foreground"
                        }
                      >
                        {e.status}
                      </Pill>
                    </td>
                    <td className="px-4 py-3">
                      {isAdmin ? (
                        <span className="block text-right text-muted-foreground text-xs">—</span>
                      ) : (
                        <div className="flex items-center gap-2 justify-end">
                          <select
                            value={chosen}
                            disabled={busy}
                            onChange={(ev) => setRoleChoice({ ...roleChoice, [e.id]: ev.target.value })}
                            className="h-8 px-2 rounded-lg bg-background border border-border text-foreground text-xs focus:outline-none focus:ring-3 focus:ring-ring/50"
                          >
                            <option value="EMPLOYEE">Employee</option>
                            <option value="ASSET_MANAGER">Asset Manager</option>
                            <option value="DEPARTMENT_HEAD">Department Head</option>
                          </select>
                          <Button
                            size="sm"
                            variant="outline"
                            className="cursor-pointer"
                            disabled={busy || chosen === currentRole}
                            onClick={() => send(e.id, `/api/employees/${e.id}/promote`, "POST", { role: chosen })}
                          >
                            Save role
                          </Button>
                          <Button
                            size="sm"
                            className="cursor-pointer"
                            variant={e.status === "ACTIVE" ? "destructive" : "default"}
                            disabled={busy}
                            onClick={() =>
                              send(e.id, `/api/employees/${e.id}/status`, "PATCH", {
                                status: e.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                              })
                            }
                          >
                            {e.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
